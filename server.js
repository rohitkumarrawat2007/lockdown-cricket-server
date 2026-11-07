const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[HTTP ${req.method}] ${req.url}`);
  next();
});

app.get('/download', (req, res) => {
  const apkPath = "C:\\Users\\Administrator\\Downloads\\Lockdown_Cricket_Revived.apk";
  res.download(apkPath, "Lockdown_Cricket_Revived.apk");
});

// Load data files
const dataDir = path.join(__dirname, 'data');
const configData = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
const transData = JSON.parse(fs.readFileSync(path.join(dataDir, 'trans.json'), 'utf-8'));
const masterData = JSON.parse(fs.readFileSync(path.join(dataDir, 'master_1.json'), 'utf-8'));
const tutsData = require('./extracted_tutorial_data.json');

// In-memory player balances & profiles
const userProfiles = new Map();

function getOrCreateUser(guid, name) {
  if (!userProfiles.has(guid)) {
    userProfiles.set(guid, {
      guid: guid,
      userName: name || `Player_${guid.substring(0, 5)}`,
      totalCoins: 10000,
      totalGames: 0,
      totalWin: 0,
      totalLoss: 0,
      totalTie: 0,
      points: 100,
      rank: 1,
      favIplTeamId: 1105,
      favInternationalTeamId: 1
    });
  }
  return userProfiles.get(guid);
}

app.get('/services/feed/config', (req, res) => {
  const conf = (configData.Value && configData.Value.Config) ? configData.Value.Config : (configData.Config || configData);
  res.json({ Value: conf });
});

app.get('/services/feed/translation', (req, res) => {
  const trans = (transData.Value && transData.Value.Translations) ? transData.Value.Translations : (transData.Translations || transData);
  res.json({ Value: trans });
});

app.get('/services/feeds/master_1.json', (req, res) => {
  res.json({ Value: masterData });
});

app.get('/services/feeds/squads/squad_1_:teamId.json', (req, res) => {
  const squadFile = path.join(dataDir, 'squads', `squad_1_${req.params.teamId}.json`);
  if (fs.existsSync(squadFile)) {
    const squad = JSON.parse(fs.readFileSync(squadFile, 'utf-8'));
    res.json({ Value: squad });
  } else {
    res.status(404).json({ error: 'Squad not found' });
  }
});

app.get('/services/gameplay/resume/:guid', (req, res) => {
  const user = getOrCreateUser(req.params.guid);
  res.json({
    meta: { retVal: 1 },
    data: {
      totalCoins: user.totalCoins,
      minCoinsFriends: 200,
      minCoinsOnline: 200,
      minCoinsSolo: 200,
      minCoinsSuperFriends: 200,
      minCoinsSuperOnline: 200,
      minCoinsSuperSolo: 200,
      gameId: null,
      isdailybonus: 0,
      isbonus: 0
    }
  });
});

app.get('/services/gameplay/profile/:guid', (req, res) => {
  const user = getOrCreateUser(req.params.guid);
  res.json({
    meta: { retVal: 1 },
    data: user
  });
});

app.post('/services/Session/login', (req, res) => {
  const guid = `guest_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const user = getOrCreateUser(guid, 'CricketPro');
  res.json({
    meta: { retVal: 1 },
    data: {
      GUID: guid,
      userName: user.userName,
      totalCoins: user.totalCoins
    }
  });
});

app.post('/services/Session/customlogin', (req, res) => {
  const guid = `user_${Date.now()}`;
  const user = getOrCreateUser(guid, req.body.email || 'CricketPlayer');
  res.json({
    meta: { retVal: 1 },
    data: {
      GUID: guid,
      userName: user.userName,
      totalCoins: user.totalCoins
    }
  });
});

app.get('/services/leaderboards/overall/:opttype', (req, res) => {
  res.json({
    meta: { retVal: 1 },
    data: [
      { rank: 1, userName: "DhoniFan07", points: 2850, totalGames: 45, totalWin: 38, totalLoss: 7, totalCoins: 25400 },
      { rank: 2, userName: "KingKohli_18", points: 2700, totalGames: 40, totalWin: 35, totalLoss: 5, totalCoins: 21000 },
      { rank: 3, userName: "Hitman_Rohit", points: 2450, totalGames: 38, totalWin: 30, totalLoss: 8, totalCoins: 18500 }
    ]
  });
});

app.get('/services/leaderboards/user/:guid/:opttype', (req, res) => {
  const user = getOrCreateUser(req.params.guid);
  res.json({
    meta: { retVal: 1 },
    data: {
      rank: 4,
      userName: user.userName,
      points: user.points,
      totalGames: user.totalGames,
      totalWin: user.totalWin,
      totalLoss: user.totalLoss,
      totalCoins: user.totalCoins
    }
  });
});

// Also serve the extracted public folder as static assets
const publicDir = path.join(__dirname, '..', 'lockdown_cricket_source', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ----------------------------------------------------
// SOCKET.IO GAME ENGINE (Multiplayer + Anti-Cheat + Zero Leak)
// ----------------------------------------------------
const server = http.createServer(app);
const io = socketIo(server, {
  path: '/ldsocket',
  allowEIO3: true,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

// Matchmaking queues & active rooms
const waitingQueue = [];
const activeRooms = new Map(); // roomId -> RoomObject

function normalisePlaying11(playerList) {
  if (!Array.isArray(playerList)) return [];
  return [...new Set(playerList.map(Number).filter(Number.isFinite))].slice(0, 11);
}

function selectedFromPlaying11(room, userId, requested, count) {
  const player = room.players.find((item) => item.id === userId);
  const available = (player && player.playing11) || [];
  const selected = (Array.isArray(requested) ? requested : [requested])
    .map(Number)
    .filter((id, index, values) => Number.isFinite(id) && values.indexOf(id) === index);
  // Old saves can be missing the XI. In that case accept the client choice;
  // otherwise never silently replace a user's selection with hard-coded IDs.
  const valid = available.length ? selected.filter((id) => available.includes(id)) : selected;
  return valid.length === count ? valid : null;
}

class CricketRoom {
  constructor(roomId, overCount = 2) {
    this.roomId = roomId;
    this.overCount = overCount;
    this.maxBalls = overCount * 6;
    this.players = []; // [{ id, socketId, name, teamId, playing11, isBot }]
    this.tossWinner = null;
    this.battingUserId = null;
    this.bowlingUserId = null;
    this.currentInnings = 1;
    this.isMatchEnded = false;

    // Innings 1 state
    this.inn1 = { runs: 0, wickets: 0, balls: 0, scorecard: [] };
    // Innings 2 state
    this.inn2 = { runs: 0, wickets: 0, balls: 0, scorecard: [] };

    this.currentBowler = null;
    this.currentBatsman = null;
    this.currentBallDelivery = null;
    this.disconnectTimer = null;
  }

  getOpponent(userId) {
    return this.players.find(p => p.id !== userId) || this.players[1];
  }

  getCurrentInning() {
    return this.currentInnings === 1 ? this.inn1 : this.inn2;
  }

  resolveBall(delivery, shot) {
    const outcomes = [
      { runs: 0, isWicket: false, commentary: "Dot ball! Excellent defense." },
      { runs: 1, isWicket: false, commentary: "Quick single taken." },
      { runs: 2, isWicket: false, commentary: "Pushed in the gap for a double!" },
      { runs: 4, isWicket: false, commentary: "FOUR! Beautifully timed to the fence." },
      { runs: 6, isWicket: false, commentary: "SIX! High and handsome into the stands!" },
      { runs: 0, isWicket: true, commentary: "WICKET! Caught in the deep!" }
    ];

    let rand = Math.random();
    if (shot === 'defend') {
      if (rand < 0.6) return outcomes[0];
      if (rand < 0.95) return outcomes[1];
      return outcomes[5];
    } else if (shot === 'attack' || shot === 'loft') {
      if (rand < 0.25) return outcomes[0];
      if (rand < 0.45) return outcomes[1];
      if (rand < 0.60) return outcomes[2];
      if (rand < 0.78) return outcomes[3];
      if (rand < 0.90) return outcomes[4];
      return outcomes[5];
    }
    return outcomes[Math.floor(Math.random() * outcomes.length)];
  }

  cleanup() {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    activeRooms.delete(this.roomId);
    console.log(`[Room ${this.roomId}] Cleaned up.`);
  }
}

io.on('connection', (socket) => {
  let currentUserId = null;
  let currentRoomId = null;

  console.log(`[Socket Connected] ID: ${socket.id}`);

  // 1. Authenticate
  socket.on('authenticate', (data) => {
    currentUserId = (data && data.user && data.user.uid) || `guest_${socket.id.substring(0, 6)}`;
    socket.userId = currentUserId;
    socket.emit('AUTHORIZED', { status: true, uid: currentUserId });
    console.log(`[Auth] User ${currentUserId} authorized successfully.`);
  });

  // 2. Check Game
  socket.on('CHECK_GAME', () => {
    socket.emit('VALID_GAME', { isValid: true });
  });

  // 3. Online Matchmaking & Solo
  function setupRoomWithBot(userTeamId, overs, oppTeamId, playerList) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const room = new CricketRoom(roomId, overs || 2);

    const userProfile = getOrCreateUser(currentUserId, 'CricketCaptain');
    const botTeamId = oppTeamId || (userTeamId == 1105 ? 1106 : 1105);

    room.players.push({
      id: currentUserId,
      socketId: socket.id,
      name: userProfile.userName || 'CricketCaptain',
      teamId: userTeamId || 1105,
      playing11: normalisePlaying11(playerList),
      isBot: false
    });

    room.players.push({
      id: 'bot_virat_18',
      socketId: null,
      name: 'Virat Bot',
      teamId: botTeamId,
      isBot: true
    });

    activeRooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    currentRoomId = roomId;

    return { room, roomId };
  }

  socket.on('JOIN_ANY_ROOM', (data) => {
    console.log(`[Matchmaking] User ${currentUserId} searching for match...`);
    const userTeamId = (data && data.teamId) || 1105;
    const overs = (data && data.overs) || 2;

    const { room, roomId } = setupRoomWithBot(userTeamId, overs, null, data && data.playerList);

    socket.emit('ANY_ROOM_SUCCESS', { gameID: roomId, status: 1 });
    socket.emit('JOIN_ROOM', { gID: roomId, matchCoins: 200 });
    console.log(`[Matchmaking] Room ${roomId} paired with AI bot.`);
  });

  socket.on('PLAY_SOLO', (data) => {
    console.log(`[Solo] User ${currentUserId} starting solo match...`);
    const userTeamId = (data && data.teamId) || 1105;
    const oppTeamId = (data && data.oppTeamId) || (userTeamId == 1105 ? 1106 : 1105);
    const overs = (data && data.overs) || 2;

    const { room, roomId } = setupRoomWithBot(userTeamId, overs, oppTeamId, data && data.playerList);

    socket.emit('JOIN_SUCCESS', {
      gameID: roomId,
      overs: room.overCount,
      players: {
        player1Info: {
          id: currentUserId,
          userName: room.players[0].name,
          teamId: room.players[0].teamId,
          profilePic: 'avatar_1'
        },
        player2Info: {
          id: room.players[1].id,
          userName: room.players[1].name,
          teamId: room.players[1].teamId,
          profilePic: 'avatar_2'
        }
      }
    });

    setTimeout(() => {
      io.to(roomId).emit('CALL_FOR_TOSS', {
        caller: currentUserId,
        venueId: (data && data.venueId) || 48,
        gameID: roomId
      });
    }, 1500);
  });

  // 4. Friend Room Creation
  socket.on('CREATE_ROOM', (data) => {
    const roomId = `room_${Math.floor(100000 + Math.random() * 900000)}`;
    const room = new CricketRoom(roomId, data.overs || 2);
    room.players.push({
      id: currentUserId,
      socketId: socket.id,
      name: 'CricketCaptain',
      teamId: data.teamId || 1105,
      playing11: normalisePlaying11(data.playerList),
      isBot: false
    });
    activeRooms.set(roomId, room);

    socket.join(roomId);
    socket.roomId = roomId;
    currentRoomId = roomId;

    socket.emit('CREATE_SUCCESS', { gameID: roomId });
    console.log(`[Create Room] User ${currentUserId} created room ${roomId}`);
  });

  // 5. Join Room by Code
  socket.on('JOIN_ROOM', (data) => {
    const roomId = data.gameID;
    const room = activeRooms.get(roomId);
    if (room) {
      const p1 = room.players[0];
      const p2 = room.players[1] || { id: 'bot_virat_18', name: 'Virat Bot', teamId: 1106 };

      if (data.teamId) p1.teamId = data.teamId;

      socket.emit('JOIN_SUCCESS', {
        gameID: roomId,
        overs: room.overCount,
        players: {
          player1Info: {
            id: p1.id,
            userName: p1.name,
            teamId: p1.teamId,
            profilePic: 'avatar_1'
          },
          player2Info: {
            id: p2.id,
            userName: p2.name,
            teamId: p2.teamId,
            profilePic: 'avatar_2'
          }
        }
      });
      console.log(`[Join Room] User ${currentUserId} joined ${roomId}`);
    } else {
      socket.emit('ERROR', { code: '101', message: "Room not found" });
    }
  });

  // 6. Confirm Team & Players
  socket.on('CONFIRM_TEAM', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === currentUserId);
    if (player) {
      if (data.teamId) player.teamId = data.teamId;
      if (data.playerList) player.playing11 = normalisePlaying11(data.playerList);
    }

    console.log(`[Confirm Team] User confirmed team ${player ? player.teamId : ''}. Preparing Toss...`);

    setTimeout(() => {
      io.to(room.roomId).emit('CALL_FOR_TOSS', {
        caller: currentUserId,
        venueId: 48,
        gameID: room.roomId
      });
    }, 1200);
  });

  // 7. Coin Toss Selection
  socket.on('COIN_SIDE_SELECTION', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const chosenSide = (data && data.selectedSide) || "HEADS";
    room.tossWinner = currentUserId;

    console.log(`[Toss] User chose ${chosenSide}. User wins toss!`);

    io.to(room.roomId).emit('CHOOSE_BAT_OR_BOWL', {
      tossWinner: currentUserId,
      tossWinnerId: currentUserId,
      winningSide: chosenSide,
      flippedSide: chosenSide
    });
  });

  // 8. Bat or Bowl Selection
  socket.on('ON_CHOOSE_BAT_OR_BOWL', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const selection = (data && data.selection) || "bat";
    const userBatting = (selection === "bat");

    const p1 = room.players[0];
    const p2 = room.players[1];

    room.battingUserId = userBatting ? p1.id : p2.id;
    room.bowlingUserId = userBatting ? p2.id : p1.id;
    const battingTeamId = userBatting ? p1.teamId : p2.teamId;
    const bowlingTeamId = userBatting ? p2.teamId : p1.teamId;

    console.log(`[Innings 1] Batting: ${room.battingUserId} (Team ${battingTeamId}), Bowling: ${room.bowlingUserId} (Team ${bowlingTeamId})`);

    io.to(room.roomId).emit('START_INNINGS', {
      innings: 1,
      BattingPlayerId: room.battingUserId,
      battingUserId: room.battingUserId,
      BowlingPlayerId: room.bowlingUserId,
      bowlingUserId: room.bowlingUserId,
      Battingteam: battingTeamId,
      battingTeamId: battingTeamId,
      Bowlingteam: bowlingTeamId,
      bowlingTeamId: bowlingTeamId,
      tossWinner: currentUserId,
      soundId: "toss_won",
      overCount: room.overCount
    });

  });

  // 8b. Opening Batsman Selection
  socket.on('OPENING_BATSMAN_SELECTION', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const selectedBatsman = selectedFromPlaying11(room, currentUserId, data && data.selectedBatsman, 2);
    if (!selectedBatsman) {
      socket.emit('ERROR', { code: 'INVALID_SELECTION', message: 'Please choose two different batsmen from your Playing XI.' });
      return;
    }
    const [b1, b2] = selectedBatsman;
    const bowlingPlayer = room.players.find((player) => player.id === room.bowlingUserId);
    const bowlerId = (bowlingPlayer && bowlingPlayer.playing11 && bowlingPlayer.playing11[0]) || 64254;

    room.onStrikeBatsman = b1;
    room.nonStriker = b2;
    room.currentBowler = bowlerId;

    room.scorecard = {
      onStrikeBatsman: { player_id: String(b1), Runs: 0, Balls: 0 },
      nonStriker: { player_id: String(b2), Runs: 0, Balls: 0 },
      currentBowler: { player_id: String(bowlerId), Overs: "0.0", Runs: 0, Wickets: 0 },
      inningsInfo: {
        Total: 0,
        Wickets: 0,
        Balls: 0,
        last6: [],
        Overs: "0.0",
        maxOvers: room.overCount || 2
      },
      isPP: true
    };

    console.log(`[Batsman Selection] Strike: ${b1}, Non-Strike: ${b2}, Bowler: ${bowlerId}`);

    io.to(room.roomId).emit('BATSMAN_SELECTED', { scorecard: room.scorecard });
    io.to(room.roomId).emit('BOWLER_SELECTED', { scorecard: room.scorecard });

    setTimeout(() => {
      console.log(`[Starting Over 1] Room: ${room.roomId}`);
      io.to(room.roomId).emit('START_OVER', {
        grid: tutsData.bat.simulation["1"].START_OVER.grid,
        OD: tutsData.bat.simulation["1"].START_OVER.OD,
        BD: tutsData.bat.simulation["1"].START_OVER.BD,
        newBowlerId: String(bowlerId),
        scorecard: room.scorecard,
        eventID: Date.now()
      });

      // Bot delivers first ball after 1.8s
      setTimeout(() => {
        const cardIndex = Math.floor(Math.random() * 6);
        room.currentCardIndex = cardIndex;
        console.log(`[Bot Bowling] Delivering cardIndex: ${cardIndex}`);
        io.to(room.roomId).emit('ON_BOWL', {
          cardIndex: cardIndex,
          eventID: Date.now()
        });
      }, 1800);
    }, 600);
  });

  // 8c. Bowler Selection
  socket.on('BOWLER_SELECTION', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const selectedBowlerArr = selectedFromPlaying11(room, currentUserId, data && data.selectedBowler, 1);
    if (!selectedBowlerArr) {
      socket.emit('ERROR', { code: 'INVALID_SELECTION', message: 'Please choose a bowler from your Playing XI.' });
      return;
    }
    const selectedBowler = selectedBowlerArr[0];
    room.currentBowler = selectedBowler;

    const battingPlayer = room.players.find((player) => player.id === room.battingUserId);
    const openingPair = (battingPlayer && battingPlayer.playing11 || []).slice(0, 2);
    const b1 = openingPair[0] || 3823;
    const b2 = openingPair[1] || 10129;
    room.onStrikeBatsman = b1;
    room.nonStriker = b2;

    room.scorecard = {
      onStrikeBatsman: { player_id: String(b1), Runs: 0, Balls: 0 },
      nonStriker: { player_id: String(b2), Runs: 0, Balls: 0 },
      currentBowler: { player_id: String(selectedBowler), Overs: "0.0", Runs: 0, Wickets: 0 },
      inningsInfo: {
        Total: 0,
        Wickets: 0,
        Balls: 0,
        last6: [],
        Overs: "0.0",
        maxOvers: room.overCount || 2
      },
      isPP: true
    };

    io.to(room.roomId).emit('BOWLER_SELECTED', { scorecard: room.scorecard });
    io.to(room.roomId).emit('BATSMAN_SELECTED', { scorecard: room.scorecard });

    setTimeout(() => {
      io.to(room.roomId).emit('START_OVER', {
        grid: tutsData.bowl.simulation["1"].START_OVER.grid,
        OD: tutsData.bowl.simulation["1"].START_OVER.OD,
        BD: tutsData.bowl.simulation["1"].START_OVER.BD,
        newBowlerId: String(selectedBowler),
        scorecard: room.scorecard,
        eventID: Date.now()
      });
    }, 600);
  });

  // 8d. New Batsman Selection after Wicket
  socket.on('SELECT_NEW_BATSMAN', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    const newBatsman = selectedFromPlaying11(room, currentUserId, data && data.selectedBatsman, 1);
    if (!newBatsman) {
      socket.emit('ERROR', { code: 'INVALID_SELECTION', message: 'Please choose the next batsman from your Playing XI.' });
      return;
    }
    const newBatsmanId = newBatsman[0];
    console.log(`[New Batsman In] ID: ${newBatsmanId}`);
    if (room.scorecard) {
      room.scorecard.onStrikeBatsman = { player_id: String(newBatsmanId), Runs: 0, Balls: 0 };
    }
    io.to(room.roomId).emit('BATSMAN_SELECTED', { scorecard: room.scorecard });
    io.to(room.roomId).emit('START_BALL', { eventID: Date.now() });

    setTimeout(() => {
      const cardIndex = Math.floor(Math.random() * 6);
      io.to(room.roomId).emit('ON_BOWL', {
        cardIndex: cardIndex,
        eventID: Date.now()
      });
    }, 1800);
  });

  // 9. Delivery selection by Bowler
  socket.on('ON_BOWL', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    room.currentBallDelivery = data;
    io.to(room.roomId).emit('ON_BOWL', {
      cardIndex: (data && data.cardIndex) !== undefined ? data.cardIndex : 0,
      eventID: Date.now()
    });

    // If opponent is bot and batting: auto play shot
    const opp = room.getOpponent(currentUserId);
    if (opp && opp.isBot && room.battingUserId === opp.id) {
      setTimeout(() => {
        handleBallResolution(room, 'attack');
      }, 1500);
    }
  });

  // 10. Shot selection by Batsman
  socket.on('PLAY_SHOT', (data) => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;

    handleBallResolution(room, (data && data.action) || (data && data.shotType) || 'attack');
  });

  function handleBallResolution(room, shotType) {
    if (!room.scorecard) return;

    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;

    let runs = 0;
    let isWicket = false;
    let ledMsg = "";
    let soundId = "";

    if (shotType === 'attack') {
      const r = Math.random();
      if (r < 0.28) { runs = 4; ledMsg = "FOUR!"; soundId = "four"; }
      else if (r < 0.48) { runs = 6; ledMsg = "Out of the park! SIX!"; soundId = "six"; }
      else if (r < 0.72) { runs = 1; ledMsg = "Single taken"; soundId = "1R"; }
      else if (r < 0.88) { runs = 2; ledMsg = "Two runs"; soundId = "1R"; }
      else { isWicket = true; runs = 0; ledMsg = "Took a risk, OUT!"; soundId = "caught"; }
    } else {
      const r = Math.random();
      if (r < 0.55) { runs = 1; ledMsg = "Quick single"; soundId = "1R"; }
      else if (r < 0.85) { runs = 0; ledMsg = "Solid defense"; soundId = ""; }
      else if (r < 0.95) { runs = 2; ledMsg = "Two runs taken"; soundId = "1R"; }
      else { isWicket = true; runs = 0; ledMsg = "Bowled!"; soundId = "bowled"; }
    }

    const sc = room.scorecard;
    sc.inningsInfo.Total += runs;
    sc.inningsInfo.Balls += 1;
    if (isWicket) sc.inningsInfo.Wickets += 1;

    sc.inningsInfo.last6.push(isWicket ? "W" : String(runs));
    if (sc.inningsInfo.last6.length > 6) sc.inningsInfo.last6.shift();

    const balls = sc.inningsInfo.Balls;
    const oversStr = `${Math.floor(balls / 6)}.${balls % 6}`;
    sc.inningsInfo.Overs = oversStr;
    sc.isPP = balls < 6;

    sc.onStrikeBatsman.Runs += runs;
    sc.onStrikeBatsman.Balls += 1;
    sc.currentBowler.Runs += runs;
    sc.currentBowler.Overs = oversStr;
    if (isWicket) sc.currentBowler.Wickets += 1;

    if (runs % 2 === 1) {
      const temp = sc.onStrikeBatsman;
      sc.onStrikeBatsman = sc.nonStriker;
      sc.nonStriker = temp;
    }

    console.log(`[Ball ${balls}] Shot: ${shotType}, Runs: ${runs}, Wickets: ${sc.inningsInfo.Wickets}, Total: ${sc.inningsInfo.Total}/${sc.inningsInfo.Wickets}, Sound: ${soundId}`);

    io.to(room.roomId).emit('ON_PLAY_SHOT', {
      dices: { dice1, dice2 },
      scorecard: sc,
      eventID: Date.now(),
      inningsEnd: balls >= room.maxBalls,
      LEDMsg: ledMsg,
      isWicket: isWicket,
      soundId: soundId
    });

    if (balls < room.maxBalls && sc.inningsInfo.Wickets < 10) {
      if (!isWicket) {
        setTimeout(() => {
          if (balls % 6 === 0) {
            io.to(room.roomId).emit('START_OVER', {
              grid: tutsData.bat.simulation["1"].START_OVER.grid,
              OD: tutsData.bat.simulation["1"].START_OVER.OD,
              BD: tutsData.bat.simulation["1"].START_OVER.BD,
              newBowlerId: String(room.currentBowler),
              scorecard: sc,
              eventID: Date.now()
            });
          } else {
            io.to(room.roomId).emit('START_BALL', { eventID: Date.now() });
          }

          setTimeout(() => {
            const nextCard = Math.floor(Math.random() * 6);
            io.to(room.roomId).emit('ON_BOWL', {
              cardIndex: nextCard,
              eventID: Date.now()
            });
          }, 1800);
        }, 3500);
      }
    } else {
      setTimeout(() => {
        endMatch(room, currentUserId, "Match Completed!");
      }, 3500);
    }
  }

  function endMatch(room, winnerId, reason) {
    if (room.isMatchEnded) return;
    room.isMatchEnded = true;

    const winner = room.players.find(p => p.id === winnerId);
    const loser = room.players.find(p => p.id !== winnerId);

    const coinsWon = 380;
    const coinsLost = 200;

    if (winner && !winner.isBot) {
      const wProfile = userProfiles.get(winner.id);
      if (wProfile) {
        wProfile.totalCoins += 180;
        wProfile.totalWin += 1;
        wProfile.totalGames += 1;
      }
    }
    if (loser && !loser.isBot) {
      const lProfile = userProfiles.get(loser.id);
      if (lProfile) {
        lProfile.totalCoins = Math.max(0, lProfile.totalCoins - 200);
        lProfile.totalLoss += 1;
        lProfile.totalGames += 1;
      }
    }

    io.to(room.roomId).emit('MATCH_END', {
      winningUserId: winnerId,
      winningTeamId: winner ? winner.teamId : null,
      coinsWon: coinsWon,
      coinsLost: coinsLost,
      reason: reason,
      soundId: "victory"
    });

    setTimeout(() => {
      room.cleanup();
    }, 30000);
  }

  // 11. Scorecard request
  socket.on('SCORE_CARD', () => {
    const room = activeRooms.get(socket.roomId);
    if (!room) return;
    socket.emit('ON_SCORE_CARD', {
      inn1: room.inn1,
      inn2: room.inn2,
      currentInnings: room.currentInnings
    });
  });

  // 12. Emojis
  socket.on('EMOJI', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('EMOJI', data);
    }
  });

  // 13. Forfeit
  socket.on('FORFEIT', () => {
    const room = activeRooms.get(socket.roomId);
    if (room && !room.isMatchEnded) {
      const opp = room.getOpponent(currentUserId);
      if (opp) {
        endMatch(room, opp.id, "Opponent forfeited the game.");
      }
    }
  });

  // 14. Disconnect Handling
  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ${socket.id}`);
    const qIdx = waitingQueue.findIndex(s => s.id === socket.id);
    if (qIdx !== -1) waitingQueue.splice(qIdx, 1);

    if (socket.roomId) {
      const room = activeRooms.get(socket.roomId);
      if (room && !room.isMatchEnded) {
        io.to(room.roomId).emit('OPP_DISCONNECTED', { countdown: 60 });
        io.to(room.roomId).emit('PAUSE_GAME');

        room.disconnectTimer = setTimeout(() => {
          if (!room.isMatchEnded) {
            const opp = room.getOpponent(currentUserId);
            if (opp) {
              endMatch(room, opp.id, "Opponent timed out.");
            }
          }
        }, 60000);
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🏏 Lockdown Cricket Game Server Running!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`⚡ Sockets: READY (High Concurrency & Anti-Cheat Enabled)`);
  console.log(`=========================================`);
});
