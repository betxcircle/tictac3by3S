const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const OdinCircledbModel = require("./models/odincircledb");
const BetModel = require("./models/BetModel");
const WinnerModel = require("./models/WinnerModel");
const LoserModel = require("./models/LoserModel");

require("dotenv").config();

const app = express();
app.use(cors());

const server = http.createServer(app);
// const { v4: uuidv4 } = require('uuid'); // Import UUID for unique room IDs


// MongoDB Connection
const uri = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_CLUSTER}.kbgr5.mongodb.net/${process.env.MONGO_DATABASE}?retryWrites=true&w=majority`;

mongoose
  .connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const activeRooms = {};

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

socket.on("joinRoom", async ({ playerName, userId, amount, expoPushToken }) => {
    console.log(`🔹 Player ${playerName} (ID: ${userId}) is trying to join a room with bet amount: ${amount}`);

    // Validate required fields
    if (!playerName || !userId || amount == null) {
        console.log("❌ Error: Missing required fields.");
        return socket.emit("invalidJoin", "Missing required fields");
    }

    // Look for an existing room with space
    let room = Object.values(activeRooms).find(r => r.amount === amount && r.players.length < 3);

    if (room) {
        console.log(`🔍 Found an existing room: ${room.roomId} with ${room.players.length} players.`);

        // 🧼 If it's a reused room, reset the state (clean slate)
        if (room.players.length === 0) {
            console.log(`♻️ Resetting old room ${room.roomId} to fresh state`);
            room.board = Array(16).fill(null);
            room.currentPlayer = 0;
            room.startingPlayer = 0;
        }

    } else {
        // No room? Create one
        const newRoomId = generateRoomId();
        console.log(`🆕 Creating a new Room with ID: ${newRoomId}`);

        room = {
            roomId: newRoomId,
            players: [],
            board: Array(16).fill(null),
            currentPlayer: 0,
            startingPlayer: 0,
            amount,
        };

        activeRooms[newRoomId] = room;
    }

    // If room is full, reject the request
    if (room.players.length >= 3) {
        console.log(`🚫 Room ${room.roomId} is full.`);
        return socket.emit("roomFull", "Room is already full.");
    }

   const playerIndex = room.players.length;

    // Assign player symbol
    const symbols = ["X", "O", "B"];
    const playerNumber = room.players.length + 1;
    const playerSymbol = symbols[playerNumber - 1];

    console.log(`🎭 Assigning symbol "${playerSymbol}" to Player ${playerNumber}`);

    // Add player to room
    room.players.push({
        name: playerName,
        userId,
        socketId: socket.id,
        amount,
        playerNumber,
        symbol: playerSymbol,
        expoPushToken,
        playerIndex, // Assign player index here
    });

    // Join the socket room
    socket.join(room.roomId);
    console.log(`✅ ${playerName} joined Room ${room.roomId} as Player ${playerNumber}`);

  
  // Send the assigned player index back to the client
socket.emit("playerAssigned", {
  playerIndex, // should be 0, 1, or 2
  symbol: ["X", "O", "B"][playerIndex],
});


    // **NEW** - Emit event to inform the player they successfully joined
    socket.emit("roomJoined", { roomId: room.roomId, amount, players: room.players });

    // Notify others in the room
    socket.to(room.roomId).emit("playerJoined", { playerName, roomId: room.roomId });
    io.to(room.roomId).emit("playersUpdate", room.players);

    console.log(`🔄 Updated Room ${room.roomId} Players List:`, room.players);

    // If 3 players are present, start the game
    if (room.players.length === 3) {
       startGame(room)
       room.currentPlayer = room.players[0].userId; // Set current turn to first player
        console.log(`🎮 Game in Room ${room.roomId} is READY!`);

        io.to(room.roomId).emit("gameReady", {
            players: room.players.map((p) => ({ name: p.name, symbol: p.symbol, amount: p.amount })),
            roomId: room.roomId,
            amount: room.amount,
        });

        room.currentPlayer = room.startingPlayer;
        io.to(room.roomId).emit("turnChange", room.currentPlayer);
    }
});





socket.on("checkRoom", ({ roomId }, callback) => {
    const roomExists = io.sockets.adapter.rooms.has(roomId);
    callback({ exists: roomExists });
});

socket.on("getRoomData", ({ userId }) => {
    const room = findRoomByUserId(userId); // Function to find user's room
    if (room) {
        io.to(socket.id).emit("roomData", { roomId: room.id, players: room.players });
    }
});

async function startGame(room) {
    console.log(`🎮 Starting ff game in Room ${room.roomId}...`);

    try {
        // Fetch both players from the database
        const player1 = await OdinCircledbModel.findById(room.players[0].userId);
        const player2 = await OdinCircledbModel.findById(room.players[1].userId);
        const player3 = await OdinCircledbModel.findById(room.players[2].userId);

        if (!player1 || !player2 || !player3) {
            console.log("❌ Error: One, two or three players not found in the database.");
            io.to(room.roomId).emit("invalidGameStart", "Players not found");
            return;
        }

        // Check if both players have enough balance
        if (player1.wallet.balance < room.amount || player2.wallet.balance < room.amount || player3.wallet.balance < room.amount) {
            console.log("❌ Error: One, two or three or both players have insufficient balance.");
            io.to(room.roomId).emit("invalidGameStart", "One or all players have insufficient balance");
            return;
        }

        // Deduct the balance from both players
        player1.wallet.balance -= room.amount;
        player2.wallet.balance -= room.amount;
        player3.wallet.balance -= room.amount;

        // Save the updated balances
        await player1.save();
        await player2.save();
        await player3.save();

        // Update total bet in the room
        room.totalBet = room.amount * 3;

        console.log(`💰 Balance deducted from both players. Total Bet: ${room.totalBet}`);

        // Emit updated balances to players
        io.to(player1.socketId).emit("balanceUpdated", { newBalance: player1.wallet.balance });
        io.to(player2.socketId).emit("balanceUpdated", { newBalance: player2.wallet.balance });
        io.to(player2.socketId).emit("balanceUpdated", { newBalance: player3.wallet.balance });

        // Emit game start event
       // io.to(room.roomId).emit("gameStart", { message: "Game is starting!", room });
    } catch (error) {
        console.error("❌ Error starting game:", error);
        io.to(room.roomId).emit("invalidGameStart", "Server error while starting the game");
    }
}


  
const startTurnTimer = (roomId) => {
  const room = activeRooms[roomId];
  if (!room) return;

  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
  }

  room.turnTimeout = setTimeout(() => {
    console.log(`⏰ Player took too long. Switching turn for room ${roomId}`);

    // Switch turn
    room.currentPlayer = (room.currentPlayer + 1) % 3;
    const currentPlayer = room.players[room.currentPlayer];

    if (!currentPlayer) {
      console.error('⚠️ No current player found');
      return;
    }

    // Emit turn change
    io.to(roomId).emit('turnChange', currentPlayer.userId);
    console.log('🔄 Emitting turnChange:', currentPlayer.userId);

    // Delay restart of the timer slightly
    setTimeout(() => startTurnTimer(roomId), 100);
  }, 3000);
};


   
 socket.on('makeMove', async ({ roomId, index, playerName, symbol }) => {
  const room = activeRooms[roomId];

  // Check if room exists and has a players array
  if (!room || !Array.isArray(room.players)) {
    console.error(`Invalid room or players array for roomId: ${roomId}`);
    return socket.emit('invalidMove', 'Invalid game state');
  }

  // Initialize room.currentPlayer if necessary
  if (typeof room.currentPlayer !== 'number') {
    console.error(`Invalid currentPlayer for roomId: ${roomId}`);
    room.currentPlayer = 0; // Default to player 0
  }

  if (!room) {
    return socket.emit('invalidMove', 'Room not found');
  }

  const currentPlayerIndex = room.currentPlayer % 3;
  const currentPlayer = room.players[currentPlayerIndex];

     // Check if currentPlayer exists and has userId
  if (currentPlayer && currentPlayer.hasOwnProperty('userId')) {
    console.log('Current player userId:', currentPlayer.userId);
  } else {
    console.error('Error: currentPlayer is missing userId');
    return socket.emit('invalidMove', 'Invalid player state');
  }

  if (socket.id === currentPlayer.socketId) {
    if (room.board[index] === null) {
      room.board[index] = currentPlayer.symbol;
      
      // Move is made, clear the existing turn timeout
      if (room.turnTimeout) {
        clearTimeout(room.turnTimeout);
      }

      // Emit move made and turn change
      io.to(roomId).emit('moveMade', { index, symbol: currentPlayer.symbol, playerName: currentPlayer.name, board: room.board });

   // Change turn
// Change turn
    room.currentPlayer = (room.currentPlayer + 1) % 3;

    // ⚠️ Fetch the *new* current player based on updated index
    const nextPlayer = room.players[room.currentPlayer];

    if (!nextPlayer || !nextPlayer.userId) {
      console.error('Error: nextPlayer is missing userId');
      return;
    }

    // Notify frontend
    io.to(roomId).emit('turnChange', nextPlayer.userId);
    console.log('🔄 Emitting turnChange:', nextPlayer.userId);

    startTurnTimer(roomId); // Restart timer
      
      const winnerSymbol = checkWin(room.board);

      if (winnerSymbol) {
        clearTimeout(room.turnTimeout); // **Stop turn timer if someone wins**
        
        const winnerPlayer = room.players.find(player => player.symbol === winnerSymbol);
       const loserPlayers = room.players.filter(player => player.symbol !== winnerSymbol);
      
        if (winnerPlayer && loserPlayers) {
          const winnerUserId = winnerPlayer.userId;
          //const loserUserId = loserPlayer.userId;
          const gameResult = `${winnerPlayer.name} (${winnerSymbol}) wins!`;

          // Access the totalBet from the room object
         // Ensure all players have a valid amount

// Add the totalBet to the winner's balance
//winnerUser.wallet.cashoutbalance += totalBet;
//await winnerUser.save();
       const totalBet = room.players.reduce((sum, player) => {
    const amount = Number(player.amount); // Convert to number
    return isNaN(amount) ? sum : sum + amount;
  }, 0);

console.log('Winner balance updated successfully');

          // Emit 'gameOver' event with winner and loser info
          // iooo.to(roomId).emit('gameOver', { 
          //   winnerSymbol, 
          //   result: gameResult, 
          //   totalBet, 
          //   winnerUserId, 
          //   winnerPlayer, 
          //   loserUserId, 
          //   loserPlayer 
          // });
             // Emit different events for winner and loser
  io.to(winnerPlayer.socketId).emit('winnerScreen', { 
    result: gameResult, 
    totalBet, 
    winnerUserId, 
    winnerPlayer 
  });

  loserPlayers.forEach(loserPlayer => {
  io.to(loserPlayer.socketId).emit('loserScreen', { 
    result: gameResult, 
    totalBet, 
    loserUserId: loserPlayer.userId, 
    loserPlayer 
  });
});



          try {
            // Update the winner's balance in the database
            const winnerUser = await OdinCircledbModel.findById(winnerUserId);

  if (!winnerUser) {
    console.error(`Winner user not found: ${winnerUserId}`);
    return;
  }

  // Ensure all players have a valid amount before calculating totalBet
  const totalBet = room.players.reduce((sum, player) => {
    const amount = Number(player.amount); // Convert to number
    return isNaN(amount) ? sum : sum + amount;
  }, 0);

  console.log(`Calculated totalBet: ${totalBet}`);

  // Validate totalBet before using it
  if (isNaN(totalBet) || totalBet <= 0) {
    console.error(`Invalid totalBet value: ${totalBet}`);
    return;
  }

  // Ensure winner's cashoutbalance is valid
  if (typeof winnerUser.wallet.cashoutbalance !== 'number') {
    console.error(`Invalid cashoutbalance: ${winnerUser.wallet.cashoutbalance}`);
    winnerUser.wallet.cashoutbalance = 0; // Default to 0 if undefined
  }

  
            if (winnerUser) {
              winnerUser.wallet.cashoutbalance += totalBet;
              await winnerUser.save();

              // Save winner record
              const newWinner = new WinnerModel({
                roomId,
                winnerName: winnerUserId,
                totalBet: totalBet,
              });
              await newWinner.save();
              console.log('Winner saved to database:', newWinner);

              // Save loser record
         for (const loserPlayer of loserPlayers) {
  const newLoser = new LoserModel({
    roomId,
    loserName: loserPlayer.userId,
    totalBet
  });
  await newLoser.save();
  console.log('Loser saved to database:', newLoser);
}


             
            } else {
              console.error('Winner user not found');
            }
          } catch (error) {
            console.error('Error updating winner balance:', error);
          }
        }
      } else if (room.board.every((cell) => cell !== null)) {
        clearTimeout(room.turnTimeout); // **Stop timer on draw**

        // It's a draw
        io.to(roomId).emit('gameDraw', { 
          winnerSymbol: null, 
          result: "It's a draw!", 
          winnerUserId: null 
        });

        // Reset the game state for a new game
        room.board = Array(16).fill(null);
        room.startingPlayer = (room.startingPlayer + 1) % 3;
        room.currentPlayer = room.startingPlayer;

        io.to(roomId).emit('newGame', 
                             { message: "The game has been reset due to a draw. New game starting!",
                              startingPlayer: room.startingPlayer 
                             });
      }
    } else {
      return socket.emit('invalidMove', room.board[index] !== null ? 'Cell already occupied' : "It's not your turn");
    }
  }
});
  
socket.on("disconnect", async () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    for (const roomId in activeRooms) {
        const room = activeRooms[roomId];

        if (room) {
            const playerIndex = room.players.findIndex((player) => player.socketId === socket.id);

            if (playerIndex !== -1) {
                const [disconnectedPlayer] = room.players.splice(playerIndex, 1);

                io.to(roomId).emit("playerLeft", { 
                    message: `${disconnectedPlayer.playerName} left the game`, 
                    roomId,
                    players: room.players
                });

                const winnerSymbol = checkWin(room.board);
                if (winnerSymbol) {
                    console.log("🏆 Game already has a winner, no need to award the remaining player.");
                    return;
                }

                if (room.players.length === 1) {
                    const winnerPlayer = room.players[0];
                    console.log(`🏆 ${winnerPlayer.playerName} is the default winner because others disconnected.`);

                    try {
                        const winnerUser = await OdinCircledbModel.findById(winnerPlayer.userId);
                        if (winnerUser) {
                            winnerUser.wallet.cashoutbalance += room.totalBet;
                            await winnerUser.save();

                            io.to(winnerPlayer.socketId).emit("winnerScreen", {
                                result: `You win! All other players disconnected.`,
                                totalBet: room.totalBet,
                                winnerUserId: winnerPlayer.userId,
                                winnerPlayer
                            });

                            console.log(`💰 ${winnerPlayer.playerName} received ${room.totalBet} coins as the default winner.`);
                        } else {
                            console.error("❌ Winner user not found in the database.");
                        }
                    } catch (error) {
                        console.error("❌ Error updating winner balance on opponent disconnect:", error);
                    }

                    // Delete room after awarding
                    delete activeRooms[roomId];
                } else if (room.players.length >= 2) {
                    // Let the game continue with the remaining players
                    console.log("ℹ️ A player left, game continues with remaining players.");
                    io.to(roomId).emit("playerListUpdate", {
                        players: room.players,
                        message: `${disconnectedPlayer.playerName} has left the game. Game continues.`
                    });
                }

                if (room.players.length === 0) {
                    delete activeRooms[roomId];
                }
            }
        }
    }
});

});



function generateRoomId() {
  return Math.random().toString(36).substr(2, 9); // Generate a random alphanumeric string
}

const checkWin = (board) => {
  const winningLines = [
    // Rows
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9, 10, 11],
    [12, 13, 14, 15],

    // Columns
    [0, 4, 8, 12],
    [1, 5, 9, 13],
    [2, 6, 10, 14],
    [3, 7, 11, 15],

    // Diagonals
    [0, 5, 10, 15],
    [3, 6, 9, 12],
  ];

  for (let line of winningLines) {
    const [a, b, c, d] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c] && board[a] === board[d]) {
      return board[a];
    }
  }

  return null;
};



server.listen(5005, () => console.log("🚀 Server running on port 5005"));
