let sessions = new Map();
let publishers = new Map();
let idlePlayers = new Set();
let stat = {
    inBytes : 0,
    outBytes : 0,
    accepted : 0
};

module.exports = {sessions, publishers, idlePlayers, stat};