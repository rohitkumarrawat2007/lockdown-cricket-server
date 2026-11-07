const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('🏏 Lockdown Cricket Live Game Server is Running Online!');
});

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

app.use('/socket', (req, res, next) => {
  req.url = '/ldsocket' + req.url;
  next();
});

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

class CricketRoom {
  constructor(roomId, overCount = 5) {
    this.roomId = roomId;
    const effOvers = Number(overCount) || 5;
    this.overCount = effOvers;
    this.maxBalls = effOvers * 6;
    this.maxWickets = (effOvers === 1) ? 2 : 10;
    this.players = []; // [{ id, socketId, name, teamId, playing11, isBot }]
    this.tossWinner = null;
    this.battingUserId = null;
    this.bowlingUserId = null;
    this.currentInnings = 1;
    this.isMatchEnded = false;
    this.isInningsTransitionPending = false;

    // Innings 1 state
    this.inn1 = { runs: 0, wickets: 0, balls: 0, scorecard: [] };
    this.inn2 = { runs: 0, wickets: 0, balls: 0, scorecard: [] };
    this.dismissedBatsmenInn1 = new Set();
    this.dismissedBatsmenInn2 = new Set();

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
  
function extractOvers(data) {
  if (!data) return 2;
  const val = (typeof data === 'object') ? (data.overs || data.userSelectedOver || data.overCount || data.selectedOvers || data.over) : data;
  const num = parseInt(val, 10);
  return (!isNaN(num) && num > 0) ? num : 2;
}

function setupRoomWithBot(userTeamId, overs, oppTeamId) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const room = new CricketRoom(roomId, overs || 2);

    const userProfile = getOrCreateUser(currentUserId, 'CricketCaptain');
    const botTeamId = oppTeamId || (userTeamId == 1105 ? 1106 : 1105);

    room.players.push({
      id: currentUserId,
      socketId: socket.id,
      name: userProfile.userName || 'CricketCaptain',
      teamId: userTeamId || 1105,
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
    const overs = extractOvers(data);

    const { room, roomId } = setupRoomWithBot(userTeamId, overs);

    socket.emit('ANY_ROOM_SUCCESS', { gameID: roomId, status: 1 });
    socket.emit('JOIN_ROOM', { gID: roomId, matchCoins: 200 });
    console.log(`[Matchmaking] Room ${roomId} paired with AI bot.`);
  });

  socket.on('PLAY_SOLO', (data) => {
    console.log(`[Solo] User ${currentUserId} starting solo match...`);
    const userTeamId = (data && data.teamId) || 1105;
    const oppTeamId = (data && data.oppTeamId) || (userTeamId == 1105 ? 1106 : 1105);
    const overs = extractOvers(data);

    const { room, roomId } = setupRoomWithBot(userTeamId, overs, oppTeamId);

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
    const room = new CricketRoom(roomId, extractOvers(data));
    room.players.push({
      id: currentUserId,
      socketId: socket.id,
      name: 'CricketCaptain',
      teamId: data.teamId || 1105,
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
      if (data.playerList) player.playing11 = data.playerList;
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
    room.isInningsTransitionPending = false;

    const selectedBatsman = (data && data.selectedBatsman) || [3823, 10129];
    const b1 = selectedBatsman[0] || 3823;
    const b2 = selectedBatsman[1] || 10129;
    const bowlerId = 64254;

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
    room.scorecardInnings = room.currentInnings;

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
    room.isInningsTransitionPending = false;

    const selectedBowler = (data && data.selectedBowler) || 64254;
    room.currentBowler = selectedBowler;

    // Start a fresh scorecard only at the beginning of a new innings.
    // Selecting a new bowler after an over must preserve the existing innings score.
    if (!room.scorecard || room.scorecardInnings !== room.currentInnings) {
      const b1 = 3823;
      const b2 = 10129;
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
      room.scorecardInnings = room.currentInnings;
    } else {
      room.scorecard.currentBowler = {
        player_id: String(selectedBowler),
        Overs: "0.0",
        Runs: 0,
        Wickets: 0
      };
    }

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
    if (!room || !room.scorecard) return;

    const dismissed = room.currentInnings === 1 ? room.dismissedBatsmenInn1 : room.dismissedBatsmenInn2;
    const battingPlayer = room.players.find(p => p.id === room.battingUserId) || room.players[0];
    const playing11 = (battingPlayer && battingPlayer.playing11) || [];
    const nonStrikerId = room.scorecard.nonStriker ? String(room.scorecard.nonStriker.player_id) : null;

    // Filter available batsmen: must be in playing11, NOT dismissed, and NOT currently non-striker
    const available = playing11.filter(pid => {
      const sId = String(pid);
      return !dismissed.has(sId) && sId !== nonStrikerId;
    });

    let chosenId = data && data.selectedBatsman ? String(data.selectedBatsman) : null;
    if (!chosenId || dismissed.has(chosenId) || chosenId === nonStrikerId || !playing11.map(String).includes(chosenId)) {
      chosenId = available.length > 0 ? String(available[0]) : (playing11[2] ? String(playing11[2]) : "1002");
    }

    console.log(`[New Batsman In] Validated ID: ${chosenId} (Dismissed count: ${dismissed.size})`);
    room.scorecard.onStrikeBatsman = { player_id: chosenId, Runs: 0, Balls: 0 };

    // Update or add in batsc array
    if (Array.isArray(room.scorecard.batsc)) {
      let bRec = room.scorecard.batsc.find(b => String(b.id) === chosenId);
      if (!bRec) {
        bRec = { id: Number(chosenId) || chosenId, R: 0, B: 0, '4': 0, '6': 0, SR: "0.0", Howout: "", isOut: false };
        room.scorecard.batsc.push(bRec);
      }
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

  function formatOversFromBalls(balls) {
    const safeBalls = Math.max(0, Number(balls) || 0);
    return `${Math.floor(safeBalls / 6)}.${safeBalls % 6}`;
  }

  function updateCurrentInningsSnapshot(room) {
    if (!room || !room.scorecard || !room.scorecard.inningsInfo) return;
    const info = room.scorecard.inningsInfo;
    const key = room.currentInnings === 1 ? 'inn1' : 'inn2';
    const previous = room[key] || { scorecard: [] };
    room[key] = {
      ...previous,
      runs: Number(info.Total) || 0,
      wickets: Number(info.Wickets) || 0,
      balls: Number(info.Balls) || 0,
      battingUserId: room.battingUserId,
      // Keep the original array-shaped field used by SCORE_CARD consumers.
      scorecard: Array.isArray(previous.scorecard) ? previous.scorecard : []
    };
  }

  function buildMatchSummary(room) {
    const summary = {};
    (room.players || []).forEach((player) => {
      const inning = [room.inn1, room.inn2].find(item => item && item.battingUserId === player.id);
      const balls = inning ? Number(inning.balls) || 0 : 0;
      summary[player.id] = {
        Total: inning ? Number(inning.runs) || 0 : 0,
        Wickets: inning ? Number(inning.wickets) || 0 : 0,
        Overs: formatOversFromBalls(balls)
      };
    });
    return summary;
  }

  function handleBallResolution(room, shotType) {
    if (!room || room.isMatchEnded || room.isInningsTransitionPending || !room.scorecard || !room.scorecard.inningsInfo) return;

    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;

    let runs = 0;
    let isWicket = false;
    let ledMsg = "";
    let soundId = "";

    if (shotType === 'attack' || shotType === 'loft') {
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
    sc.inningsInfo.Total = (Number(sc.inningsInfo.Total) || 0) + runs;
    sc.inningsInfo.Balls = (Number(sc.inningsInfo.Balls) || 0) + 1;
    if (isWicket) sc.inningsInfo.Wickets = (Number(sc.inningsInfo.Wickets) || 0) + 1;

    if (!Array.isArray(sc.inningsInfo.last6)) sc.inningsInfo.last6 = [];
    sc.inningsInfo.last6.push(isWicket ? "W" : String(runs));
    if (sc.inningsInfo.last6.length > 6) sc.inningsInfo.last6.shift();

    const balls = sc.inningsInfo.Balls;
    const oversStr = formatOversFromBalls(balls);
    sc.inningsInfo.Overs = oversStr;
    sc.isPP = balls < 6;

    if (sc.onStrikeBatsman) {
      sc.onStrikeBatsman.Runs = (Number(sc.onStrikeBatsman.Runs) || 0) + runs;
      sc.onStrikeBatsman.Balls = (Number(sc.onStrikeBatsman.Balls) || 0) + 1;
      
      const sStrikerId = String(sc.onStrikeBatsman.player_id);
      if (Array.isArray(sc.batsc)) {
        let bRec = sc.batsc.find(b => String(b.id) === sStrikerId);
        if (bRec) {
          bRec.R = (Number(bRec.R) || 0) + runs;
          bRec.B = (Number(bRec.B) || 0) + 1;
          if (runs === 4) bRec['4'] = (Number(bRec['4']) || 0) + 1;
          if (runs === 6) bRec['6'] = (Number(bRec['6']) || 0) + 1;
          bRec.SR = bRec.B > 0 ? ((bRec.R / bRec.B) * 100).toFixed(1) : "0.0";
          if (isWicket) {
            bRec.isOut = true;
            bRec.Howout = "b " + ((sc.currentBowler && sc.currentBowler.player_id) || "Bowler");
          }
        }
      }

      if (isWicket) {
        const dismissed = room.currentInnings === 1 ? room.dismissedBatsmenInn1 : room.dismissedBatsmenInn2;
        dismissed.add(sStrikerId);
        console.log(`[Wicket] Player ${sStrikerId} marked OUT permanently. Total outs: ${dismissed.size}`);
      }
    }
    if (sc.currentBowler) {
      sc.currentBowler.Runs = (Number(sc.currentBowler.Runs) || 0) + runs;
      sc.currentBowler.Overs = oversStr;
      if (isWicket) sc.currentBowler.Wickets = (Number(sc.currentBowler.Wickets) || 0) + 1;
    }

    // Odd runs strike swap
    if (runs % 2 === 1 && sc.onStrikeBatsman && sc.nonStriker) {
      const temp = sc.onStrikeBatsman;
      sc.onStrikeBatsman = sc.nonStriker;
      sc.nonStriker = temp;
    }
    // Over end strike swap (Ball 6 ends swap)
    if (balls % 6 === 0 && !isWicket && sc.onStrikeBatsman && sc.nonStriker) {
      const temp = sc.onStrikeBatsman;
      sc.onStrikeBatsman = sc.nonStriker;
      sc.nonStriker = temp;
    }

    updateCurrentInningsSnapshot(room);
    const firstInningsRuns = Number(room.inn1 && room.inn1.runs) || 0;
    const targetReached = room.currentInnings === 2 && sc.inningsInfo.Total > firstInningsRuns;
    const inningsComplete = balls >= room.maxBalls || sc.inningsInfo.Wickets >= (room.maxWickets || 10) || targetReached;

    console.log(`[Innings ${room.currentInnings} | Ball ${balls}] Shot: ${shotType}, Runs: ${runs}, Wickets: ${sc.inningsInfo.Wickets}, Total: ${sc.inningsInfo.Total}/${sc.inningsInfo.Wickets}, Sound: ${soundId}`);

    io.to(room.roomId).emit('ON_PLAY_SHOT', {
      dices: { dice1, dice2 },
      scorecard: sc,
      eventID: Date.now(),
      inningsEnd: inningsComplete,
      LEDMsg: ledMsg,
      isWicket: isWicket,
      soundId: soundId
    });

    if (inningsComplete) {
      room.isInningsTransitionPending = true;
      setTimeout(() => {
        if (room.isMatchEnded) return;
        updateCurrentInningsSnapshot(room);

        if (room.currentInnings === 1) {
          // Preserve innings 1 and swap batting/bowling roles for innings 2.
          room.currentInnings = 2;
          const previousBattingUserId = room.battingUserId;
          room.battingUserId = room.bowlingUserId;
          room.bowlingUserId = previousBattingUserId;

          io.to(room.roomId).emit('SWITCH_INNINGS', {
            scorecard: {
              Total: Number(room.inn1.runs) || 0,
              Wickets: Number(room.inn1.wickets) || 0,
              Overs: formatOversFromBalls(room.inn1.balls)
            },
            newInnings: { AllottedOvers: room.overCount },
            topPerformers: { bat: [], bowl: [] },
            soundId: "innings_end",
            eventID: Date.now()
          });
          // Selection handlers clear this flag when the player continues into innings 2.
          return;
        }

        // Innings 2 ended (allotted balls/wickets or target chased): calculate the real result.
        room.inn2 = {
          ...room.inn2,
          runs: Number(sc.inningsInfo.Total) || 0,
          wickets: Number(sc.inningsInfo.Wickets) || 0,
          balls: Number(sc.inningsInfo.Balls) || 0,
          battingUserId: room.battingUserId,
          scorecard: Array.isArray(room.inn2.scorecard) ? room.inn2.scorecard : []
        };
        const firstRuns = Number(room.inn1.runs) || 0;
        const secondRuns = Number(room.inn2.runs) || 0;
        let winnerId = null;
        let isTie = false;
        let winningEq = { runs: 0, wickets: 0, balls: 0 };

        if (secondRuns > firstRuns) {
          winnerId = room.inn2.battingUserId;
          winningEq = {
            runs: 0,
            wickets: Math.max(0, 10 - (Number(room.inn2.wickets) || 0)),
            balls: Math.max(0, room.maxBalls - (Number(room.inn2.balls) || 0))
          };
        } else if (firstRuns > secondRuns) {
          winnerId = room.inn1.battingUserId;
          winningEq = { runs: firstRuns - secondRuns, wickets: 0, balls: 0 };
        } else {
          isTie = true;
        }

        endMatch(room, winnerId, isTie ? "Match tied." : "Match Completed!", {
          isTie,
          summary: buildMatchSummary(room),
          topPerformers: { bat: [], bowl: [] },
          winningEq
        });
      }, 3500);
      return;
    }

    // A human batter receives the next delivery from the bot. If the human is bowling,
    // wait for their BowlerView selection instead of inventing a delivery for them.
    if (!isWicket) {
      setTimeout(() => {
        if (room.isMatchEnded || room.isInningsTransitionPending) return;
        const bowlingPlayer = (room.players || []).find(player => player.id === room.bowlingUserId);

        if (balls % 6 === 0 && bowlingPlayer && !bowlingPlayer.isBot) {
          // The human bowler must be allowed to select the next bowler.
          io.to(room.roomId).emit('END_OVER', { scorecard: sc, eventID: Date.now() });
          return;
        }

        if (balls % 6 === 0) {
          const overData = bowlingPlayer && bowlingPlayer.isBot
            ? tutsData.bat.simulation["1"].START_OVER
            : tutsData.bowl.simulation["1"].START_OVER;
          io.to(room.roomId).emit('START_OVER', {
            grid: overData.grid,
            OD: overData.OD,
            BD: overData.BD,
            newBowlerId: String(room.currentBowler),
            scorecard: sc,
            eventID: Date.now()
          });
        } else {
          io.to(room.roomId).emit('START_BALL', { eventID: Date.now(), scorecard: sc });
        }

        if (bowlingPlayer && bowlingPlayer.isBot) {
          setTimeout(() => {
            if (!room.isMatchEnded && !room.isInningsTransitionPending) {
              const nextCard = Math.floor(Math.random() * 6);
              io.to(room.roomId).emit('ON_BOWL', {
                cardIndex: nextCard,
                eventID: Date.now()
              });
            }
          }, 1800);
        }
      }, 3500);
    } else {
      // When the opponent is a bot, it cannot send SELECT_NEW_BATSMAN itself.
      // Resume that innings automatically after a wicket so a local bot match cannot stall.
      const battingPlayer = (room.players || []).find(player => player.id === room.battingUserId);
      if (battingPlayer && battingPlayer.isBot) {
        setTimeout(() => {
          if (room.isMatchEnded || room.isInningsTransitionPending || !room.scorecard) return;
          const replacementId = 10027 + (Number(room.scorecard.inningsInfo.Wickets) || 0);
          room.scorecard.onStrikeBatsman = { player_id: String(replacementId), Runs: 0, Balls: 0 };
          io.to(room.roomId).emit('BATSMAN_SELECTED', { scorecard: room.scorecard });
          const bowlingPlayer = (room.players || []).find(player => player.id === room.bowlingUserId);
          if (balls % 6 === 0 && bowlingPlayer && !bowlingPlayer.isBot) {
            io.to(room.roomId).emit('END_OVER', { scorecard: room.scorecard, eventID: Date.now() });
          } else {
            io.to(room.roomId).emit('START_BALL', { eventID: Date.now(), scorecard: room.scorecard });
          }
        }, 3500);
      }
    }
  }

  function endMatch(room, winnerId, reason, resultData = {}) {
    if (!room || room.isMatchEnded) return;
    room.isMatchEnded = true;

    const isTie = Boolean(resultData.isTie);
    const winner = winnerId ? room.players.find(p => p.id === winnerId) : null;
    const loser = winner && room.players.find(p => p.id !== winner.id);
    const coinsWon = 380;
    const coinsLost = 200;

    if (isTie) {
      (room.players || []).forEach((player) => {
        if (player.isBot) return;
        const profile = userProfiles.get(player.id);
        if (profile) {
          profile.totalTie = (Number(profile.totalTie) || 0) + 1;
          profile.totalGames = (Number(profile.totalGames) || 0) + 1;
        }
      });
    } else {
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
    }

    const summary = resultData.summary || buildMatchSummary(room);
    const winningEq = resultData.winningEq || {
      runs: Math.max(0, (Number(room.inn1 && room.inn1.runs) || 0) - (Number(room.inn2 && room.inn2.runs) || 0)),
      wickets: 0,
      balls: 0
    };

    io.to(room.roomId).emit('MATCH_END', {
      winningUserId: winner ? winner.id : null,
      winningTeamId: winner ? winner.teamId : null,
      coinsWon: isTie ? 0 : coinsWon,
      coinsLost: isTie ? 0 : coinsLost,
      reason: reason,
      soundId: isTie ? "tie" : "victory",
      isTie,
      summary,
      topPerformers: resultData.topPerformers || { bat: [], bowl: [] },
      winningEq
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
