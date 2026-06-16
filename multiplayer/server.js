const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active games
const games = new Map();
const playerToRoom = new Map();

// Game Engine
class CheckersGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.board = this.initializeBoard();
    this.players = { red: null, black: null };
    this.currentTurn = 'red';
    this.moveHistory = [];
  }

  initializeBoard() {
    const board = Array(8)
      .fill(null)
      .map(() => Array(8).fill(null));

    // Place red pieces (top)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = { type: 'red', isKing: false };
        }
      }
    }

    // Place black pieces (bottom)
    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = { type: 'black', isKing: false };
        }
      }
    }

    return board;
  }

  isValidMove(fromRow, fromCol, toRow, toCol, playerColor) {
    // Check if it's the player's turn
    if (this.currentTurn !== playerColor) {
      return false;
    }

    const piece = this.board[fromRow]?.[fromCol];
    if (!piece || piece.type !== playerColor) return false;

    // Destination must be empty
    if (this.board[toRow]?.[toCol] !== null) return false;

    // Check bounds
    if (toRow < 0 || toRow >= 8 || toCol < 0 || toCol >= 8) return false;

    const rowDiff = Math.abs(toRow - fromRow);
    const colDiff = Math.abs(toCol - fromCol);

    // Regular move: 1 square diagonally
    if (rowDiff === 1 && colDiff === 1) {
      if (!piece.isKing) {
        if (piece.type === 'red' && toRow > fromRow) return true;
        if (piece.type === 'black' && toRow < fromRow) return true;
      } else {
        return true;
      }
    }

    // Jump move: 2 squares diagonally
    if (rowDiff === 2 && colDiff === 2) {
      const midRow = (fromRow + toRow) / 2;
      const midCol = (fromCol + toCol) / 2;
      const capturedPiece = this.board[midRow]?.[midCol];

      if (capturedPiece && capturedPiece.type !== piece.type) {
        if (!piece.isKing) {
          if (piece.type === 'red' && toRow > fromRow) return true;
          if (piece.type === 'black' && toRow < fromRow) return true;
        } else {
          return true;
        }
      }
    }

    return false;
  }

  movePiece(fromRow, fromCol, toRow, toCol, playerColor) {
    if (!this.isValidMove(fromRow, fromCol, toRow, toCol, playerColor)) {
      return false;
    }

    const piece = this.board[fromRow][fromCol];
    const rowDiff = Math.abs(toRow - fromRow);

    // Handle capture
    if (rowDiff === 2) {
      const midRow = (fromRow + toRow) / 2;
      const midCol = (fromCol + toCol) / 2;
      this.board[midRow][midCol] = null;
    }

    // Move piece
    this.board[toRow][toCol] = piece;
    this.board[fromRow][fromCol] = null;

    // King promotion
    if ((piece.type === 'red' && toRow === 7) || (piece.type === 'black' && toRow === 0)) {
      piece.isKing = true;
    }

    // Switch turn
    this.currentTurn = this.currentTurn === 'red' ? 'black' : 'red';
    this.moveHistory.push({ from: [fromRow, fromCol], to: [toRow, toCol] });

    return true;
  }

  getGameState() {
    return {
      board: this.board,
      currentTurn: this.currentTurn,
      players: this.players,
      roomId: this.roomId
    };
  }
}

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Find or create a room for the player
  let room = null;
  for (const [roomId, game] of games.entries()) {
    if (!game.players.red || !game.players.black) {
      room = roomId;
      break;
    }
  }

  // Create new room if needed
  if (!room) {
    room = `room-${Date.now()}`;
    const newGame = new CheckersGame(room);
    games.set(room, newGame);
  }

  const game = games.get(room);
  playerToRoom.set(socket.id, room);

  // Assign player color
  let playerColor;
  if (!game.players.red) {
    playerColor = 'red';
    game.players.red = socket.id;
  } else {
    playerColor = 'black';
    game.players.black = socket.id;
  }

  socket.join(room);

  // Send initial game state
  socket.emit('playerAssigned', {
    color: playerColor,
    gameState: game.getGameState()
  });

  // Notify both players
  io.to(room).emit('gameUpdate', game.getGameState());

  // Handle move
  socket.on('makeMove', (data) => {
    const { fromRow, fromCol, toRow, toCol } = data;

    if (game.movePiece(fromRow, fromCol, toRow, toCol, playerColor)) {
      io.to(room).emit('gameUpdate', game.getGameState());
    } else {
      socket.emit('invalidMove', { message: 'Invalid move' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    playerToRoom.delete(socket.id);

    // Notify other player
    io.to(room).emit('playerLeft', { color: playerColor });

    // Clean up empty rooms
    if (!game.players.red || !game.players.black) {
      // Don't delete room yet, let player rejoin if they reconnect
    }
  });

  // Handle reset
  socket.on('resetGame', () => {
    if (socket.id === game.players.red || socket.id === game.players.black) {
      const newGame = new CheckersGame(room);
      newGame.players = game.players;
      games.set(room, newGame);
      io.to(room).emit('gameUpdate', newGame.getGameState());
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Checkers server running on http://localhost:${PORT}`);
});
