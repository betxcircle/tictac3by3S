const mongoose = require('mongoose');

const LoserSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
    },
    loserName: {
        type: String,
        required: true,
    },
    betAmount: {
        type: Number,
    },
    totalBet: {
        type: Number,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const LoserModel = mongoose.model('Loser', LoserSchema);

module.exports = LoserModel;
