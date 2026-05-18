const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require.extensions[".ts"] = require.extensions[".js"];

const { gameConfig } = require("../src/config/gameConfig.ts");
const { bannedWords } = require("../src/data/bannedWords.ts");

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const PUBLIC_IMAGES_DIR = path.join(process.cwd(), "public", "game-images");
const REQUEST_THROTTLE_MS = 700;
const BANNED_WORD_CACHE_MS = 5000;
const ADMIN_SESSION_COOKIE = "jjal_matchjang_admin_session";

const DEFAULT_SETTINGS = {
  roundCount: 5,
  captionSeconds: 45,
  voteSeconds: 25,
  minPlayers: 2,
  maxPlayers: 8
};

const rooms = new Map();
const playerBySocket = new Map();
const adminSessions = new Map();
const adminLoginAttempts = new Map();

let cleanupInterval = null;
let ioRef = null;
let prismaRef = null;
let imageCache = [];
let imageCacheInitialized = false;
let bannedWordCache = [];
let bannedWordCacheAt = 0;

function setupGameSocket(io, prisma) {
  ioRef = io;
  prismaRef = prisma;

  seedPersistentData(prisma).catch((error) => {
    logServerError("Failed to seed persistent data", error);
  });
  startCleanupInterval(io);

  io.on("connection", (socket) => {
    socket.emit("rooms:list", getPublicRooms());

    socket.on("rooms:list", () => {
      socket.emit("rooms:list", getPublicRooms());
    });

    socket.on("room:reconnect", (payload, callback) => {
      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey);
      const roomCode = normalizeRoomCode(payload?.roomCode);
      if (!sessionId) return reply(callback, false, "재접속 세션이 없습니다.");

      const room = roomCode ? rooms.get(roomCode) : findRoomBySessionId(sessionId);
      if (!room) return reply(callback, false, "복귀할 방을 찾을 수 없습니다.");

      pruneExpiredDisconnectedPlayers(room);
      const player = findPlayerBySession(room, sessionId);
      if (!player) return reply(callback, false, "재접속 시간이 만료되었습니다.");
      if (isBannedFromRoom(room, sessionId, player.nickname)) {
        return reply(callback, false, "이 방에서는 다시 입장할 수 없습니다.");
      }

      reconnectPlayer(io, socket, room, player);
      ensurePlayerProfile(player);
      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("room:create", async (payload, callback) => {
      leaveCurrentRoom(io, socket, { remove: true });

      const nickname = normalizeNickname(payload?.nickname);
      if (!nickname) return reply(callback, false, "닉네임을 입력해 주세요.");

      const settings = normalizeSettings(payload?.settings);
      const code = createRoomCode();
      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey) || createId();
      const player = createPlayer(socket, nickname, sessionId);
      ensurePlayerProfile(player);
      const now = Date.now();
      const room = {
        code,
        name: normalizeRoomName(payload?.roomName) || `${nickname}의 방`,
        isPublic: payload?.isPublic !== false,
        streamerMode: Boolean(payload?.streamerMode),
        hideRoomCode: Boolean(payload?.hideRoomCode),
        hostId: player.id,
        settings,
        phase: "lobby",
        players: [player],
        bannedPlayerIds: [],
        bannedNicknames: [],
        roundIndex: 0,
        currentImage: null,
        submissions: [],
        chatMessages: [],
        usedImages: [],
        rounds: [],
        winnerIds: [],
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        lastActivityAt: now,
        endsAt: null,
        timer: null,
        scoredRound: false
      };

      rooms.set(code, room);
      socket.join(code);
      playerBySocket.set(socket.id, { roomCode: code, playerId: player.id });
      addSystemChatMessage(room, `${nickname}님이 방을 만들었습니다.`);
      logEvent("room_created", "Room created", { roomCode: code, actor: nickname, metadata: roomSummary(room) });
      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("room:join", (payload, callback) => {
      const nickname = normalizeNickname(payload?.nickname);
      const code = normalizeRoomCode(payload?.code);
      if (!nickname) return reply(callback, false, "닉네임을 입력해 주세요.");
      if (!code) return reply(callback, false, "방 코드를 입력해 주세요.");

      const room = rooms.get(code);
      if (!room) return reply(callback, false, "방을 찾을 수 없습니다.");
      pruneExpiredDisconnectedPlayers(room);

      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey) || createId();
      const existingPlayer = findPlayerBySession(room, sessionId);
      if (existingPlayer) {
        if (isBannedFromRoom(room, sessionId, existingPlayer.nickname)) {
          return reply(callback, false, "이 방에서는 다시 입장할 수 없습니다.");
        }
        reconnectPlayer(io, socket, room, existingPlayer);
        ensurePlayerProfile(existingPlayer);
        reply(callback, true, null, { state: serializeRoom(room, existingPlayer.id) });
        emitRoomState(io, room);
        emitPublicRooms(io);
        return;
      }

      if (room.phase !== "lobby") return reply(callback, false, "이미 시작된 방입니다.");
      if (isRoomFull(room)) return reply(callback, false, "방이 가득 찼습니다.");
      if (isBannedFromRoom(room, sessionId, nickname)) {
        return reply(callback, false, "이 방에서는 다시 입장할 수 없습니다.");
      }

      leaveCurrentRoom(io, socket, { remove: true });
      const player = createPlayer(socket, nickname, sessionId);
      ensurePlayerProfile(player);
      room.players.push(player);
      touchRoom(room);
      socket.join(code);
      playerBySocket.set(socket.id, { roomCode: code, playerId: player.id });
      addSystemChatMessage(room, `${player.nickname}님이 입장했습니다.`);

      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("room:quickJoin", (payload, callback) => {
      const nickname = normalizeNickname(payload?.nickname);
      if (!nickname) return reply(callback, false, "닉네임을 입력해 주세요.");

      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey) || createId();
      const room = [...rooms.values()].find((candidate) => {
        pruneExpiredDisconnectedPlayers(candidate);
        return candidate.isPublic &&
          candidate.phase === "lobby" &&
          !isRoomFull(candidate) &&
          !isBannedFromRoom(candidate, sessionId, nickname);
      });

      if (!room) return reply(callback, false, "참가 가능한 공개방이 없습니다.");

      leaveCurrentRoom(io, socket, { remove: true });
      const player = createPlayer(socket, nickname, sessionId);
      ensurePlayerProfile(player);
      room.players.push(player);
      touchRoom(room);
      socket.join(room.code);
      playerBySocket.set(socket.id, { roomCode: room.code, playerId: player.id });
      addSystemChatMessage(room, `${player.nickname}님이 입장했습니다.`);

      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("room:leave", () => {
      leaveCurrentRoom(io, socket, { remove: true });
      socket.emit("rooms:list", getPublicRooms());
    });

    socket.on("profile:mine", async (payload, callback) => {
      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey);
      const nickname = normalizeNickname(payload?.nickname) || "익명";
      if (!sessionId) return reply(callback, false, "플레이어 세션이 없습니다.");

      try {
        const profile = await upsertPlayerProfile(sessionId, nickname);
        reply(callback, true, null, { profile: formatPlayerProfile(profile) });
      } catch (error) {
        logServerError("Failed to load player profile", error);
        reply(callback, false, "플레이어 정보를 불러오지 못했습니다.");
      }
    });

    socket.on("profile:get", async (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");

      const { room, player } = result;
      const roomCode = normalizeRoomCode(payload?.roomCode);
      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey);
      if (roomCode !== room.code || sessionId !== player.playerSessionId) {
        return reply(callback, false, "플레이어 정보를 볼 권한이 없습니다.");
      }

      const target = room.players.find((candidate) => candidate.id === payload?.playerId);
      if (!target) return reply(callback, false, "플레이어를 찾을 수 없습니다.");

      try {
        const profile = await upsertPlayerProfile(target.playerSessionId, target.nickname);
        reply(callback, true, null, { profile: formatPlayerProfile(profile) });
      } catch (error) {
        logServerError("Failed to load public player profile", error);
        reply(callback, false, "플레이어 정보를 불러오지 못했습니다.");
      }
    });

    socket.on("room:kick", (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");

      const { room, player } = result;
      if (isRateLimited(player, "kick")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");
      if (room.hostId !== player.id) return reply(callback, false, "방장만 강퇴할 수 있습니다.");

      const target = room.players.find((candidate) => candidate.id === payload?.targetPlayerId);
      if (!target) return reply(callback, false, "플레이어를 찾을 수 없습니다.");
      if (target.id === player.id) return reply(callback, false, "방장은 자기 자신을 강퇴할 수 없습니다.");

      addBan(room, target);
      removePlayerFromRoom(io, room, target, {
        message: "방장에 의해 강퇴되었습니다.",
        eventName: "room:kicked",
        forceRemove: true
      });
      addSystemChatMessage(room, `${target.nickname}님이 강퇴되었습니다.`);
      touchRoom(room);
      logEvent("player_kicked", "Player kicked by host", {
        roomCode: room.code,
        actor: player.nickname,
        metadata: { target: target.nickname }
      });
      reply(callback, true);
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("room:updateSettings", (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");

      const { room, player } = result;
      if (room.hostId !== player.id) return reply(callback, false, "방장만 설정을 변경할 수 있습니다.");
      if (room.phase !== "lobby") return reply(callback, false, "게임 시작 후에는 방 설정을 변경할 수 없습니다.");
      if (isRateLimited(player, "settings")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");

      const currentPlayerCount = connectedPlayers(room).length;
      const nextSettings = normalizeSettings(payload?.settings || room.settings);
      if (currentPlayerCount > nextSettings.maxPlayers) {
        return reply(callback, false, "현재 인원보다 최대 인원을 낮게 설정할 수 없습니다.");
      }

      const nextName = normalizeRoomName(payload?.roomName) || room.name;
      const nextPublic = typeof payload?.isPublic === "boolean" ? payload.isPublic : room.isPublic;
      const nextStreamerMode = typeof payload?.streamerMode === "boolean" ? payload.streamerMode : Boolean(room.streamerMode);
      const nextHideRoomCode = typeof payload?.hideRoomCode === "boolean" ? payload.hideRoomCode : Boolean(room.hideRoomCode);
      const messages = describeRoomSettingChanges(room, {
        name: nextName,
        isPublic: nextPublic,
        streamerMode: nextStreamerMode,
        hideRoomCode: nextHideRoomCode,
        settings: nextSettings
      });

      if (messages.length === 0) {
        return reply(callback, true, null, { state: serializeRoom(room, player.id) });
      }

      room.name = nextName;
      room.isPublic = nextPublic;
      room.streamerMode = nextStreamerMode;
      room.hideRoomCode = nextHideRoomCode;
      room.settings = nextSettings;
      for (const message of messages) addSystemChatMessage(room, message);
      touchRoom(room);
      logEvent("room_settings_updated", "Room settings updated", {
        roomCode: room.code,
        actor: player.nickname,
        metadata: { messages }
      });
      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
      emitPublicRooms(io);
    });

    socket.on("game:start", (callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      pruneExpiredDisconnectedPlayers(room);
      if (room.hostId !== player.id) return reply(callback, false, "방장만 시작할 수 있습니다.");
      if (room.phase !== "lobby") return reply(callback, false, "이미 게임이 진행 중입니다.");
      if (connectedPlayers(room).length < room.settings.minPlayers) {
        return reply(callback, false, `최소 ${room.settings.minPlayers}명이 필요합니다.`);
      }

      room.startedAt = new Date();
      touchRoom(room);
      addSystemChatMessage(room, "게임이 시작되었습니다.");
      logEvent("game_started", "Game started", { roomCode: room.code, actor: player.nickname, metadata: roomSummary(room) });
      startRound(io, room);
      reply(callback, true);
    });

    socket.on("chat:send", async (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");

      const { room, player } = result;
      const roomCode = normalizeRoomCode(payload?.roomCode);
      const sessionId = normalizePlayerSessionId(payload?.playerSessionId || payload?.playerKey);

      if (roomCode !== room.code || sessionId !== player.playerSessionId) {
        return reply(callback, false, "채팅 권한을 확인할 수 없습니다.");
      }
      if (isBannedFromRoom(room, player.playerSessionId, player.nickname)) {
        return reply(callback, false, "이 방에서는 채팅을 보낼 수 없습니다.");
      }
      if (isRateLimited(player, "chat", gameConfig.chatCooldownMs)) {
        return reply(callback, false, "채팅은 잠시 후 다시 보낼 수 있습니다.");
      }

      const validation = validateChatMessage(payload?.message);
      if (!validation.ok) return reply(callback, false, validation.error);
      if (await containsBannedWord(validation.message)) {
        return reply(callback, false, "금칙어가 포함된 채팅은 보낼 수 없습니다.");
      }

      addPlayerChatMessage(room, player, validation.message);
      touchRoom(room);
      reply(callback, true);
      emitRoomState(io, room);
    });

    socket.on("caption:submit", async (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      if (isRateLimited(player, "caption")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");
      if (room.phase !== "caption") return reply(callback, false, "제목 작성 시간이 아닙니다.");
      if (hasSubmitted(room, player.id)) return reply(callback, false, "이미 제출했습니다.");

      const validation = validateCaption(payload?.text);
      if (!validation.ok) return reply(callback, false, validation.error);
      if (await containsBannedWord(validation.text)) {
        return reply(callback, false, "금칙어가 포함된 제목은 제출할 수 없습니다.");
      }

      room.submissions.push({
        id: createId(),
        playerId: player.id,
        text: validation.text,
        votes: [],
        reports: [],
        hidden: false,
        editCount: 0,
        edited: false
      });

      touchRoom(room);
      reply(callback, true);
      if (connectedPlayers(room).every((candidate) => hasSubmitted(room, candidate.id))) {
        finishCaptionPhase(io, room);
      } else {
        emitRoomState(io, room);
      }
    });

    socket.on("caption:update", async (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      if (isRateLimited(player, "captionEdit")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");
      if (room.phase !== "caption") return reply(callback, false, "제목 작성 시간이 아닙니다.");

      const submission = room.submissions.find((candidate) => candidate.playerId === player.id);
      if (!submission) return reply(callback, false, "수정할 제목이 없습니다.");
      if ((submission.editCount || 0) >= 1) return reply(callback, false, "제목 수정은 라운드당 1회만 가능합니다.");

      const validation = validateCaption(payload?.text);
      if (!validation.ok) return reply(callback, false, validation.error);
      if (await containsBannedWord(validation.text)) {
        return reply(callback, false, "금칙어가 포함된 제목은 제출할 수 없습니다.");
      }

      submission.text = validation.text;
      submission.editCount = (submission.editCount || 0) + 1;
      submission.edited = true;
      touchRoom(room);
      reply(callback, true, null, { state: serializeRoom(room, player.id) });
      emitRoomState(io, room);
    });

    socket.on("caption:report", async (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      if (isRateLimited(player, "report")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");

      const submission = room.submissions.find((candidate) => candidate.id === payload?.submissionId);
      if (!submission) return reply(callback, false, "제목을 찾을 수 없습니다.");
      if (submission.playerId === player.id) return reply(callback, false, "본인 제목은 신고할 수 없습니다.");
      if (submission.reports.some((report) => report.playerId === player.id)) return reply(callback, false, "이미 신고한 제목입니다.");

      const author = room.players.find((candidate) => candidate.id === submission.playerId);
      let reportRecord = null;
      try {
        reportRecord = await prismaRef.reportRecord.create({
          data: {
            roomCode: room.code,
            roundIndex: room.roundIndex,
            submissionId: submission.id,
            captionText: submission.text,
            authorPlayerId: author?.id || null,
            authorNickname: author?.nickname || "알 수 없음",
            reporterPlayerId: player.id,
            reporterNickname: player.nickname,
            status: "pending"
          }
        });
      } catch (error) {
        logServerError("Failed to save report record", error);
      }

      submission.reports.push({ playerId: player.id, recordId: reportRecord?.id || null });
      logEvent("caption_reported", "Caption reported", {
        roomCode: room.code,
        actor: player.nickname,
        metadata: { submissionId: submission.id, author: author?.nickname || null }
      });

      if (submission.reports.length >= gameConfig.autoHideReportThreshold) {
        setSubmissionHidden(room, submission, true);
        updateReportStatusForSubmission(room, submission, "hidden");
        logEvent("caption_hidden", "Caption auto-hidden by reports", {
          roomCode: room.code,
          metadata: { submissionId: submission.id, reports: submission.reports.length }
        });
      }

      touchRoom(room);
      reply(callback, true);
      emitRoomState(io, room);
      if (room.phase === "voting" && allEligibleVotersVoted(room)) {
        finishVotingPhase(io, room);
      }
    });

    socket.on("vote:submit", (payload, callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      if (isRateLimited(player, "vote")) return reply(callback, false, "요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.");
      if (room.phase !== "voting") return reply(callback, false, "투표 시간이 아닙니다.");
      if (hasVoted(room, player.id)) return reply(callback, false, "이미 투표했습니다.");

      const submission = room.submissions.find((candidate) => candidate.id === payload?.submissionId);
      if (!submission) return reply(callback, false, "제목을 찾을 수 없습니다.");
      if (submission.hidden) return reply(callback, false, "신고로 숨겨진 제목에는 투표할 수 없습니다.");
      if (submission.playerId === player.id) return reply(callback, false, "자기 제목에는 투표할 수 없습니다.");

      submission.votes.push(player.id);
      touchRoom(room);
      reply(callback, true);

      if (allEligibleVotersVoted(room)) {
        finishVotingPhase(io, room);
      } else {
        emitRoomState(io, room);
      }
    });

    socket.on("game:nextRound", (callback) => {
      const result = getRoomAndPlayer(socket);
      if (!result) return reply(callback, false, "참가 중인 방이 없습니다.");
      const { room, player } = result;
      if (room.hostId !== player.id) return reply(callback, false, "방장만 진행할 수 있습니다.");
      if (room.phase !== "results") return reply(callback, false, "결과 화면에서만 진행할 수 있습니다.");

      touchRoom(room);
      if (room.roundIndex >= room.settings.roundCount) {
        finishGame(io, prismaRef, room);
      } else {
        startRound(io, room);
      }
      reply(callback, true);
    });

    socket.on("disconnect", () => {
      leaveCurrentRoom(io, socket, { remove: false });
    });
  });
}

async function handleAdminRequest(req, res, prisma) {
  prismaRef = prismaRef || prisma;

  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      await handleAdminLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      handleAdminLogout(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/session") {
      const session = validateAdminSession(req, res);
      if (!session.ok) {
        writeJson(res, 401, { ok: false, error: session.error || "Unauthorized" });
        return;
      }
      writeJson(res, 200, { ok: true, expiresAt: session.expiresAt });
      return;
    }

    const session = validateAdminSession(req, res);
    if (!session.ok) {
      writeJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      const [logs, reports, images, dbBannedWords] = await Promise.all([
        prisma.adminLog.findMany({ orderBy: { createdAt: "desc" }, take: gameConfig.adminRecentLogLimit }),
        prisma.reportRecord.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
        prisma.gameImage.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.bannedWord.findMany({ orderBy: { createdAt: "desc" } })
      ]);

      writeJson(res, 200, {
        ok: true,
        rooms: getAdminRooms(),
        logs,
        reports,
        images: images.map(formatImageRecord),
        bannedWords: dbBannedWords
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/images") {
      const images = await prisma.gameImage.findMany({ orderBy: { createdAt: "desc" } });
      writeJson(res, 200, { ok: true, images: images.map(formatImageRecord) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readJsonBody(req);
      const result = await runAdminAction(prisma, body);
      writeJson(res, result.ok ? 200 : 400, result);
      return;
    }

    writeJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    logServerError("Admin API failed", error);
    writeJson(res, 500, { ok: false, error: "Server error" });
  }
}

async function runAdminAction(prisma, body) {
  const action = String(body?.action || "");

  if (action === "deleteRoom") {
    const room = rooms.get(normalizeRoomCode(body.roomCode));
    if (!room) return { ok: false, error: "Room not found" };
    closeRoom(ioRef, room, "관리자에 의해 방이 삭제되었습니다.");
    logEvent("admin_room_deleted", "Admin deleted room", { roomCode: room.code, actor: "admin" });
    return { ok: true };
  }

  if (action === "removePlayer") {
    const room = rooms.get(normalizeRoomCode(body.roomCode));
    if (!room) return { ok: false, error: "Room not found" };
    const player = room.players.find((candidate) => candidate.id === body.playerId);
    if (!player) return { ok: false, error: "Player not found" };
    removePlayerFromRoom(ioRef, room, player, {
      message: "관리자에 의해 방에서 퇴장되었습니다.",
      eventName: "room:closed",
      forceRemove: true
    });
    addSystemChatMessage(room, `${player.nickname}님이 관리자에 의해 퇴장되었습니다.`);
    transferHostIfNeeded(room);
    touchRoom(room);
    logEvent("admin_player_removed", "Admin removed player", {
      roomCode: room.code,
      actor: "admin",
      metadata: { player: player.nickname }
    });
    emitRoomState(ioRef, room);
    emitPublicRooms(ioRef);
    return { ok: true };
  }

  if (action === "setSubmissionHidden") {
    const room = rooms.get(normalizeRoomCode(body.roomCode));
    if (!room) return { ok: false, error: "Room not found" };
    const submission = room.submissions.find((candidate) => candidate.id === body.submissionId);
    if (!submission) return { ok: false, error: "Submission not found" };
    const hidden = Boolean(body.hidden);
    setSubmissionHidden(room, submission, hidden);
    await updateReportStatusForSubmission(room, submission, hidden ? "hidden" : "dismissed");
    logEvent(hidden ? "admin_caption_hidden" : "admin_caption_restored", hidden ? "Admin hid caption" : "Admin restored caption", {
      roomCode: room.code,
      actor: "admin",
      metadata: { submissionId: submission.id }
    });
    emitRoomState(ioRef, room);
    return { ok: true };
  }

  if (action === "setReportStatus") {
    const status = normalizeReportStatus(body.status);
    if (!status) return { ok: false, error: "Invalid status" };
    const report = await prisma.reportRecord.update({
      where: { id: String(body.reportId || "") },
      data: { status }
    });

    const room = rooms.get(report.roomCode);
    if (room) {
      const submission = room.submissions.find((candidate) => candidate.id === report.submissionId);
      if (submission && status === "hidden") setSubmissionHidden(room, submission, true);
      if (submission && status === "dismissed") {
        const hiddenReports = await prisma.reportRecord.count({
          where: {
            roomCode: room.code,
            roundIndex: room.roundIndex,
            submissionId: submission.id,
            status: "hidden"
          }
        });
        if (hiddenReports === 0) setSubmissionHidden(room, submission, false);
      }
      emitRoomState(ioRef, room);
    }

    logEvent("admin_report_status", "Admin changed report status", {
      roomCode: report.roomCode,
      actor: "admin",
      metadata: { reportId: report.id, status }
    });
    return { ok: true };
  }

  if (action === "addBannedWord") {
    const word = String(body.word || "").trim();
    if (!word) return { ok: false, error: "Word is required" };
    await prisma.bannedWord.upsert({
      where: { word },
      create: { word },
      update: {}
    });
    invalidateBannedWordCache();
    logEvent("admin_banned_word_added", "Admin added banned word", { actor: "admin", metadata: { word } });
    return { ok: true };
  }

  if (action === "deleteBannedWord") {
    await prisma.bannedWord.delete({ where: { id: String(body.id || "") } });
    invalidateBannedWordCache();
    logEvent("admin_banned_word_deleted", "Admin deleted banned word", { actor: "admin" });
    return { ok: true };
  }

  if (action === "addImage") {
    const src = normalizeImageSrc(body.src);
    if (!src) return { ok: false, error: "Image src is required" };
    await prisma.gameImage.upsert({
      where: { src },
      create: {
        src,
        title: normalizeImageTitle(body.title) || path.basename(src),
        tagsJson: JSON.stringify(normalizeTags(body.tags)),
        enabled: body.enabled !== false
      },
      update: {
        title: normalizeImageTitle(body.title) || path.basename(src),
        tagsJson: JSON.stringify(normalizeTags(body.tags)),
        enabled: body.enabled !== false
      }
    });
    await refreshImageCache(prisma);
    logEvent("admin_image_added", "Admin added image", { actor: "admin", metadata: { src } });
    return { ok: true };
  }

  if (action === "updateImage") {
    const id = String(body.id || "");
    await prisma.gameImage.update({
      where: { id },
      data: {
        title: normalizeImageTitle(body.title),
        tagsJson: JSON.stringify(normalizeTags(body.tags)),
        enabled: Boolean(body.enabled)
      }
    });
    await refreshImageCache(prisma);
    logEvent("admin_image_updated", "Admin updated image", { actor: "admin", metadata: { id } });
    return { ok: true };
  }

  if (action === "deleteImage") {
    await prisma.gameImage.delete({ where: { id: String(body.id || "") } });
    await refreshImageCache(prisma);
    logEvent("admin_image_deleted", "Admin deleted image", { actor: "admin", metadata: { id: body.id } });
    return { ok: true };
  }

  return { ok: false, error: "Unknown action" };
}

function createRoomCode() {
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => {
      return ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }).join("");
  } while (rooms.has(code));
  return code;
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function createPlayer(socket, nickname, sessionId) {
  return {
    id: createId(),
    playerSessionId: normalizePlayerSessionId(sessionId) || createId(),
    socketId: socket.id,
    nickname,
    score: 0,
    connected: true,
    disconnectedAt: null,
    lastSeenAt: Date.now(),
    rateLimits: {}
  };
}

function normalizeNickname(value) {
  const nickname = String(value || "").trim().replace(/\s+/g, " ").slice(0, 16);
  return nickname.length >= 2 ? nickname : "";
}

function normalizeRoomName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function normalizePlayerSessionId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function normalizeBanNickname(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeImageSrc(value) {
  const src = String(value || "").trim().replace(/\\/g, "/").slice(0, 500);
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("/game-images/")) return src;
  if (src.startsWith("public/game-images/")) return src.slice("public".length);
  if (src.startsWith("game-images/")) return `/${src}`;
  return "";
}

function normalizeImageTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 20);
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeReportStatus(value) {
  const status = String(value || "");
  return ["pending", "hidden", "dismissed"].includes(status) ? status : "";
}

function validateCaption(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "제목을 입력해 주세요." };
  if (text.length > gameConfig.maxCaptionLength) {
    return { ok: false, error: `제목은 최대 ${gameConfig.maxCaptionLength}자까지 입력할 수 있습니다.` };
  }
  return { ok: true, text };
}

function validateChatMessage(value) {
  const message = String(value || "").trim().replace(/\s+/g, " ");
  if (!message) return { ok: false, error: "채팅 메시지를 입력해 주세요." };
  if (message.length > gameConfig.maxChatMessageLength) {
    return { ok: false, error: `채팅은 최대 ${gameConfig.maxChatMessageLength}자까지 입력할 수 있습니다.` };
  }
  return { ok: true, message };
}

function normalizeTextForFilter(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function collapseRepeatedChars(value) {
  return value.replace(/(.)\1{2,}/gu, "$1$1");
}

async function containsBannedWord(text) {
  const words = await getBannedWordList();
  const normalizedText = normalizeTextForFilter(text);
  const collapsedText = collapseRepeatedChars(normalizedText);

  return words.some((word) => {
    const normalizedWord = normalizeTextForFilter(word);
    const collapsedWord = collapseRepeatedChars(normalizedWord);
    return normalizedWord &&
      (normalizedText.includes(normalizedWord) ||
        collapsedText.includes(normalizedWord) ||
        collapsedText.includes(collapsedWord));
  });
}

async function getBannedWordList() {
  const now = Date.now();
  if (bannedWordCache.length > 0 && now - bannedWordCacheAt < BANNED_WORD_CACHE_MS) {
    return bannedWordCache;
  }

  let dbWords = [];
  if (prismaRef) {
    try {
      dbWords = (await prismaRef.bannedWord.findMany()).map((entry) => entry.word);
    } catch (error) {
      logServerError("Failed to load banned words", error);
    }
  }

  bannedWordCache = [...new Set([...bannedWords, ...dbWords])];
  bannedWordCacheAt = now;
  return bannedWordCache;
}

function invalidateBannedWordCache() {
  bannedWordCache = [];
  bannedWordCacheAt = 0;
}

function describeRoomSettingChanges(room, next) {
  const messages = [];
  const settingLabels = {
    roundCount: ["라운드 수", "라운드"],
    captionSeconds: ["제목 작성 시간", "초"],
    voteSeconds: ["투표 시간", "초"],
    minPlayers: ["최소 시작 인원", "명"],
    maxPlayers: ["최대 인원", "명"]
  };

  if (room.name !== next.name) {
    messages.push(`방 이름이 '${room.name}' → '${next.name}'으로 변경되었습니다.`);
  }
  if (room.isPublic !== next.isPublic) {
    messages.push(`방이 ${next.isPublic ? "공개방" : "비공개방"}으로 변경되었습니다.`);
  }
  if (Boolean(room.streamerMode) !== next.streamerMode) {
    messages.push(`스트리머 모드가 ${next.streamerMode ? "켜졌습니다" : "꺼졌습니다"}.`);
  }
  if (Boolean(room.hideRoomCode) !== next.hideRoomCode) {
    messages.push(`방 코드 비공개 모드가 ${next.hideRoomCode ? "켜졌습니다" : "꺼졌습니다"}.`);
  }

  for (const [key, [label, unit]] of Object.entries(settingLabels)) {
    if (room.settings[key] !== next.settings[key]) {
      messages.push(`${label}이 ${room.settings[key]}${unit} → ${next.settings[key]}${unit}로 수정되었습니다.`);
    }
  }

  return messages;
}

function ensurePlayerProfile(player) {
  if (!player?.playerSessionId || !prismaRef?.playerProfile) return;
  upsertPlayerProfile(player.playerSessionId, player.nickname).catch((error) => {
    logServerError("Failed to ensure player profile", error);
  });
}

async function upsertPlayerProfile(playerSessionId, nickname) {
  if (!prismaRef?.playerProfile) throw new Error("PlayerProfile model is unavailable");
  const normalizedSessionId = normalizePlayerSessionId(playerSessionId);
  if (!normalizedSessionId) throw new Error("Missing playerSessionId");
  const normalizedNickname = normalizeNickname(nickname) || "익명";
  const now = new Date();

  return prismaRef.playerProfile.upsert({
    where: { playerSessionId: normalizedSessionId },
    create: {
      playerSessionId: normalizedSessionId,
      nickname: normalizedNickname,
      lastSeenAt: now
    },
    update: {
      nickname: normalizedNickname,
      lastSeenAt: now
    }
  });
}

function formatPlayerProfile(profile) {
  const totalCaptions = Number(profile.totalCaptionsSubmitted || 0);
  const totalVotes = Number(profile.totalVotesReceived || 0);
  return {
    nickname: profile.nickname,
    totalPlayedGames: profile.totalPlayedGames,
    totalPlayedRounds: profile.totalPlayedRounds,
    totalWonGames: profile.totalWonGames,
    totalRoundWins: profile.totalRoundWins,
    totalVotesReceived: totalVotes,
    totalCaptionsSubmitted: totalCaptions,
    averageVotesReceived: totalCaptions > 0 ? totalVotes / totalCaptions : 0,
    lastSeenAt: profile.lastSeenAt,
    createdAt: profile.createdAt
  };
}

function recordRoundStats(room) {
  if (!prismaRef?.playerProfile) return;

  const visible = visibleSubmissions(room);
  const maxVotes = Math.max(...visible.map((submission) => submission.votes.length), 0);
  const roundWinnerIds = maxVotes > 0
    ? new Set(visible.filter((submission) => submission.votes.length === maxVotes).map((submission) => submission.playerId))
    : new Set();

  Promise.all(room.submissions.map((submission) => {
    const player = room.players.find((candidate) => candidate.id === submission.playerId);
    if (!player) return Promise.resolve();
    return incrementPlayerProfile(player, {
      totalCaptionsSubmitted: 1,
      totalVotesReceived: submission.hidden ? 0 : submission.votes.length,
      totalRoundWins: roundWinnerIds.has(player.id) ? 1 : 0
    });
  })).catch((error) => {
    logServerError("Failed to record round stats", error);
  });
}

function recordGameStats(room) {
  if (!prismaRef?.playerProfile) return;
  const roundsPlayed = Math.max(0, room.rounds.length || room.roundIndex || 0);
  const winnerIds = new Set(room.winnerIds || []);

  Promise.all(room.players.map((player) => {
    return incrementPlayerProfile(player, {
      totalPlayedGames: 1,
      totalPlayedRounds: roundsPlayed,
      totalWonGames: winnerIds.has(player.id) ? 1 : 0
    });
  })).catch((error) => {
    logServerError("Failed to record game stats", error);
  });
}

async function incrementPlayerProfile(player, increments) {
  const profile = await upsertPlayerProfile(player.playerSessionId, player.nickname);
  const updated = await prismaRef.playerProfile.update({
    where: { playerSessionId: profile.playerSessionId },
    data: {
      totalPlayedGames: { increment: increments.totalPlayedGames || 0 },
      totalPlayedRounds: { increment: increments.totalPlayedRounds || 0 },
      totalWonGames: { increment: increments.totalWonGames || 0 },
      totalRoundWins: { increment: increments.totalRoundWins || 0 },
      totalVotesReceived: { increment: increments.totalVotesReceived || 0 },
      totalCaptionsSubmitted: { increment: increments.totalCaptionsSubmitted || 0 },
      lastSeenAt: new Date()
    }
  });

  const averageVotesReceived = updated.totalCaptionsSubmitted > 0
    ? updated.totalVotesReceived / updated.totalCaptionsSubmitted
    : 0;

  return prismaRef.playerProfile.update({
    where: { playerSessionId: profile.playerSessionId },
    data: { averageVotesReceived }
  });
}

function normalizeSettings(input) {
  const settings = {
    roundCount: clampInt(input?.roundCount, 1, 20, DEFAULT_SETTINGS.roundCount),
    captionSeconds: clampInt(input?.captionSeconds, 5, 120, DEFAULT_SETTINGS.captionSeconds),
    voteSeconds: clampInt(input?.voteSeconds, 5, 60, DEFAULT_SETTINGS.voteSeconds),
    minPlayers: clampInt(input?.minPlayers, 2, 10, DEFAULT_SETTINGS.minPlayers),
    maxPlayers: clampInt(input?.maxPlayers, 2, 20, DEFAULT_SETTINGS.maxPlayers)
  };

  if (settings.minPlayers > settings.maxPlayers) {
    settings.minPlayers = settings.maxPlayers;
  }

  return settings;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function touchRoom(room) {
  room.lastActivityAt = Date.now();
}

function isRateLimited(player, action, intervalMs = REQUEST_THROTTLE_MS) {
  const now = Date.now();
  const lastAt = player.rateLimits[action] || 0;
  player.rateLimits[action] = now;
  return now - lastAt < intervalMs;
}

function startRound(io, room) {
  clearRoomTimer(room);
  room.phase = "caption";
  room.roundIndex += 1;
  room.currentImage = pickImage(room);
  room.submissions = [];
  room.scoredRound = false;
  room.finishedAt = null;
  setRoomTimer(room, room.settings.captionSeconds, () => finishCaptionPhase(io, room));
  emitRoomState(io, room);
  emitPublicRooms(io);
}

function finishCaptionPhase(io, room) {
  if (room.phase !== "caption") return;
  clearRoomTimer(room);
  room.phase = "reveal";
  setRoomTimer(room, 3, () => startVotingPhase(io, room));
  emitRoomState(io, room);
}

function startVotingPhase(io, room) {
  if (room.phase !== "reveal") return;
  clearRoomTimer(room);

  if (visibleSubmissions(room).length < 2) {
    finishVotingPhase(io, room);
    return;
  }

  room.phase = "voting";
  setRoomTimer(room, room.settings.voteSeconds, () => finishVotingPhase(io, room));
  emitRoomState(io, room);
}

function finishVotingPhase(io, room) {
  if (room.phase !== "voting" && room.phase !== "reveal") return;
  clearRoomTimer(room);
  room.phase = "results";

  if (!room.scoredRound) {
    for (const submission of visibleSubmissions(room)) {
      const author = room.players.find((player) => player.id === submission.playerId);
      if (author) author.score += submission.votes.length;
    }
    room.scoredRound = true;
    room.rounds.push({
      round: room.roundIndex,
      image: room.currentImage,
      submissions: room.submissions.map((submission) => {
        const author = room.players.find((player) => player.id === submission.playerId);
        return {
          text: submission.hidden ? "[신고로 숨겨진 제목]" : submission.text,
          votes: submission.hidden ? 0 : submission.votes.length,
          hidden: submission.hidden,
          reports: submission.reports.length,
          authorName: author?.nickname || "알 수 없음"
        };
      })
    });
    recordRoundStats(room);
  }

  emitRoomState(io, room);
}

function finishGame(io, prisma, room) {
  clearRoomTimer(room);
  room.phase = "final";
  room.finishedAt = Date.now();
  const topScore = Math.max(...room.players.map((player) => player.score), 0);
  room.winnerIds = room.players.filter((player) => player.score === topScore).map((player) => player.id);

  prisma.gameRecord.create({
    data: {
      roomCode: room.code,
      totalRounds: room.settings.roundCount,
      winnerName: room.players
        .filter((player) => room.winnerIds.includes(player.id))
        .map((player) => player.nickname)
        .join(", "),
      playersJson: JSON.stringify(room.players.map(({ id, nickname, score }) => ({ id, nickname, score }))),
      roundsJson: JSON.stringify(room.rounds),
      startedAt: room.startedAt || new Date(),
      endedAt: new Date()
    }
  }).catch((error) => {
    logServerError("Failed to save game record", error);
  });
  recordGameStats(room);

  logEvent("game_finished", "Game finished", {
    roomCode: room.code,
    metadata: { winners: room.winnerIds, scores: room.players.map(({ nickname, score }) => ({ nickname, score })) }
  });
  emitRoomState(io, room);
  emitPublicRooms(io);
}

function pickImage(room) {
  const enabledImages = imageCache.filter((image) => image.enabled);
  if (enabledImages.length > 0) {
    const available = enabledImages.filter((image) => !room.usedImages.includes(image.src));
    const selected = available[Math.floor(Math.random() * available.length)] || enabledImages[0];
    room.usedImages.push(selected.src);
    return { src: selected.src, name: selected.title };
  }

  if (imageCacheInitialized) return null;

  const images = listGameImages();
  if (images.length === 0) {
    return { src: "/game-images/samples/sample-01.svg", name: "sample-01.svg" };
  }

  const selected = images[Math.floor(Math.random() * images.length)] || images[0];
  return selected;
}

async function seedPersistentData(prisma) {
  await Promise.all(bannedWords.map((word) => {
    return prisma.bannedWord.upsert({
      where: { word },
      create: { word },
      update: {}
    });
  }));

  const files = listGameImages();
  await Promise.all(files.map((image) => {
    return prisma.gameImage.upsert({
      where: { src: image.src },
      create: {
        src: image.src,
        title: image.name,
        tagsJson: "[]",
        enabled: true
      },
      update: {}
    });
  }));

  await refreshImageCache(prisma);
  invalidateBannedWordCache();
}

async function refreshImageCache(prisma) {
  try {
    imageCache = (await prisma.gameImage.findMany({ orderBy: { createdAt: "asc" } })).map(formatImageRecord);
    imageCacheInitialized = true;
  } catch (error) {
    logServerError("Failed to load image cache", error);
  }
}

function listGameImages() {
  if (!fs.existsSync(PUBLIC_IMAGES_DIR)) return [];
  const files = [];
  walkImages(PUBLIC_IMAGES_DIR, files);
  return files.sort((a, b) => a.src.localeCompare(b.src));
}

function walkImages(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkImages(fullPath, files);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;

    const relativePath = path.relative(path.join(process.cwd(), "public"), fullPath).replace(/\\/g, "/");
    files.push({ src: `/${relativePath}`, name: entry.name });
  }
}

function setRoomTimer(room, seconds, onExpire) {
  clearRoomTimer(room);
  room.endsAt = Date.now() + seconds * 1000;
  room.timer = setTimeout(onExpire, seconds * 1000);
}

function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.endsAt = null;
}

function hasSubmitted(room, playerId) {
  return room.submissions.some((submission) => submission.playerId === playerId);
}

function hasVoted(room, playerId) {
  return room.submissions.some((submission) => submission.votes.includes(playerId));
}

function visibleSubmissions(room) {
  return room.submissions.filter((submission) => !submission.hidden);
}

function allEligibleVotersVoted(room) {
  const visible = visibleSubmissions(room);
  const voters = connectedPlayers(room).filter((candidate) => {
    return visible.some((submission) => submission.playerId !== candidate.id);
  });
  return voters.every((candidate) => hasVoted(room, candidate.id));
}

function connectedPlayers(room) {
  return room.players.filter((player) => player.connected);
}

function isRoomFull(room) {
  return connectedPlayers(room).length >= room.settings.maxPlayers;
}

function getRoomAndPlayer(socket) {
  const membership = playerBySocket.get(socket.id);
  if (!membership) return null;
  const room = rooms.get(membership.roomCode);
  if (!room) return null;
  pruneExpiredDisconnectedPlayers(room);
  const player = room.players.find((candidate) => candidate.id === membership.playerId);
  if (!player || !player.connected) return null;
  return { room, player };
}

function findRoomBySessionId(sessionId) {
  return [...rooms.values()].find((room) => findPlayerBySession(room, sessionId));
}

function findPlayerBySession(room, sessionId) {
  return room.players.find((player) => player.playerSessionId === sessionId);
}

function reconnectPlayer(io, socket, room, player) {
  leaveCurrentRoom(io, socket, { remove: false, skipSameSessionId: player.playerSessionId });

  if (player.socketId && player.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(player.socketId);
    oldSocket?.leave(room.code);
    oldSocket?.emit("room:closed", { message: "다른 탭에서 재접속되었습니다." });
    playerBySocket.delete(player.socketId);
  }

  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  player.lastSeenAt = Date.now();
  socket.join(room.code);
  playerBySocket.set(socket.id, { roomCode: room.code, playerId: player.id });
  touchRoom(room);
}

function isBannedFromRoom(room, sessionId, nickname) {
  const normalizedNickname = normalizeBanNickname(nickname);
  return room.bannedPlayerIds.includes(sessionId) ||
    (normalizedNickname && room.bannedNicknames.includes(normalizedNickname));
}

function addBan(room, player) {
  if (player.playerSessionId && !room.bannedPlayerIds.includes(player.playerSessionId)) {
    room.bannedPlayerIds.push(player.playerSessionId);
  }

  const normalizedNickname = normalizeBanNickname(player.nickname);
  if (normalizedNickname && !room.bannedNicknames.includes(normalizedNickname)) {
    room.bannedNicknames.push(normalizedNickname);
  }
}

function addPlayerChatMessage(room, player, message) {
  addChatMessage(room, {
    id: createId(),
    type: "player",
    roomCode: room.code,
    playerId: player.id,
    playerSessionId: player.playerSessionId,
    nickname: player.nickname,
    message,
    createdAt: Date.now()
  });
}

function addSystemChatMessage(room, message) {
  addChatMessage(room, {
    id: createId(),
    type: "system",
    roomCode: room.code,
    playerId: null,
    playerSessionId: null,
    nickname: "시스템",
    message,
    createdAt: Date.now()
  });
}

function addChatMessage(room, message) {
  if (!Array.isArray(room.chatMessages)) room.chatMessages = [];
  room.chatMessages.push(message);
  const limit = Math.max(1, Number(gameConfig.maxChatHistoryPerRoom || 50));
  if (room.chatMessages.length > limit) {
    room.chatMessages = room.chatMessages.slice(room.chatMessages.length - limit);
  }
}

function removePlayerFromRoom(io, room, player, options = {}) {
  if (player.socketId) {
    io.to(player.socketId).emit(options.eventName || "room:closed", {
      message: options.message || "방에서 퇴장되었습니다."
    });
    io.sockets.sockets.get(player.socketId)?.leave(room.code);
    playerBySocket.delete(player.socketId);
  }

  if (options.forceRemove || room.phase === "lobby") {
    room.players = room.players.filter((candidate) => candidate.id !== player.id);
  } else {
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
  }
}

function leaveCurrentRoom(io, socket, options = {}) {
  const membership = playerBySocket.get(socket.id);
  if (!membership) return;

  const room = rooms.get(membership.roomCode);
  if (room) {
    const player = room.players.find((candidate) => candidate.id === membership.playerId);
    let leftNickname = "";
    if (player && player.playerSessionId !== options.skipSameSessionId) {
      if (options.remove) {
        leftNickname = player.nickname;
        room.players = room.players.filter((candidate) => candidate.id !== player.id);
      } else {
        player.connected = false;
        player.socketId = null;
        player.disconnectedAt = Date.now();
        player.lastSeenAt = Date.now();
      }
      touchRoom(room);
    }

    socket.leave(room.code);
    pruneExpiredDisconnectedPlayers(room);
    if (room.players.length === 0) {
      deleteRoom(room.code);
    } else {
      if (leftNickname) addSystemChatMessage(room, `${leftNickname}님이 퇴장했습니다.`);
      transferHostIfNeeded(room);
      emitRoomState(io, room);
    }
  }

  playerBySocket.delete(socket.id);
  emitPublicRooms(io);
}

function transferHostIfNeeded(room) {
  if (room.players.some((candidate) => candidate.id === room.hostId && candidate.connected)) return;
  room.hostId = room.players.find((candidate) => candidate.connected)?.id || room.players[0]?.id || room.hostId;
}

function setSubmissionHidden(room, submission, hidden) {
  submission.hidden = hidden;
  if (hidden) submission.votes = [];
}

async function updateReportStatusForSubmission(room, submission, status) {
  if (!prismaRef) return;
  try {
    await prismaRef.reportRecord.updateMany({
      where: {
        roomCode: room.code,
        roundIndex: room.roundIndex,
        submissionId: submission.id
      },
      data: { status }
    });
  } catch (error) {
    logServerError("Failed to update report statuses", error);
  }
}

function pruneExpiredDisconnectedPlayers(room) {
  const now = Date.now();
  const limitMs = gameConfig.reconnectGracePeriodSeconds * 1000;
  const beforeCount = room.players.length;

  room.players = room.players.filter((player) => {
    return player.connected || !player.disconnectedAt || now - player.disconnectedAt <= limitMs;
  });

  if (room.players.length !== beforeCount) {
    transferHostIfNeeded(room);
    touchRoom(room);
  }
}

function serializeRoom(room, viewerPlayerId) {
  const phaseShowsAuthor = room.phase === "results" || room.phase === "final";
  const players = room.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    score: player.score,
    connected: player.connected,
    isHost: player.id === room.hostId,
    submitted: hasSubmitted(room, player.id),
    voted: hasVoted(room, player.id)
  }));

  return {
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    streamerMode: Boolean(room.streamerMode),
    hideRoomCode: Boolean(room.hideRoomCode),
    phase: room.phase,
    hostId: room.hostId,
    currentPlayerId: viewerPlayerId,
    settings: room.settings,
    players,
    roundIndex: room.roundIndex,
    totalRounds: room.settings.roundCount,
    image: room.currentImage,
    submissions: room.submissions.map((submission) => {
      const author = room.players.find((player) => player.id === submission.playerId);
      const hidden = Boolean(submission.hidden);
      const mine = submission.playerId === viewerPlayerId;
      const canSeeText = room.phase !== "caption" || mine;
      return {
        id: submission.id,
        text: hidden ? "[신고로 숨겨진 제목]" : canSeeText ? submission.text : "제출 완료",
        votes: hidden ? 0 : submission.votes.length,
        hidden,
        reportCount: submission.reports.length,
        reportedByMe: submission.reports.some((report) => report.playerId === viewerPlayerId),
        authorId: phaseShowsAuthor ? submission.playerId : null,
        authorName: phaseShowsAuthor ? author?.nickname || "알 수 없음" : null,
        mine,
        edited: Boolean(submission.edited),
        votedByMe: submission.votes.includes(viewerPlayerId)
      };
    }),
    chatMessages: (room.chatMessages || []).map((message) => ({
      ...message,
      mine: message.playerId === viewerPlayerId
    })),
    mySubmissionId: room.submissions.find((submission) => submission.playerId === viewerPlayerId)?.id || null,
    mySubmissionText: room.submissions.find((submission) => submission.playerId === viewerPlayerId)?.text || null,
    myCaptionEditRemaining: Math.max(0, 1 - (room.submissions.find((submission) => submission.playerId === viewerPlayerId)?.editCount || 0)),
    myVoteSubmissionId: room.submissions.find((submission) => submission.votes.includes(viewerPlayerId))?.id || null,
    endsAt: room.endsAt,
    serverNow: Date.now(),
    canStart: room.phase === "lobby" && connectedPlayers(room).length >= room.settings.minPlayers,
    winnerIds: room.winnerIds
  };
}

function emitRoomState(io, room) {
  if (!io) return;
  transferHostIfNeeded(room);
  for (const player of room.players) {
    if (!player.socketId || !player.connected) continue;
    io.to(player.socketId).emit("room:state", serializeRoom(room, player.id));
  }
}

function getPublicRooms() {
  return [...rooms.values()]
    .filter((room) => {
      pruneExpiredDisconnectedPlayers(room);
      return room.isPublic && room.phase === "lobby";
    })
    .map((room) => {
      const playerCount = connectedPlayers(room).length;
      return {
        code: room.code,
        name: room.name,
        playerCount,
        maxPlayers: room.settings.maxPlayers,
        roundCount: room.settings.roundCount,
        captionSeconds: room.settings.captionSeconds,
        status: "대기 중",
        isFull: playerCount >= room.settings.maxPlayers
      };
    })
    .sort((a, b) => Number(a.isFull) - Number(b.isFull) || a.name.localeCompare(b.name, "ko"));
}

function emitPublicRooms(io) {
  if (!io) return;
  io.emit("rooms:list", getPublicRooms());
}

function getAdminRooms() {
  return [...rooms.values()].map((room) => ({
    ...roomSummary(room),
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostId,
      disconnectedAt: player.disconnectedAt
    })),
    submissions: room.submissions.map((submission) => {
      const author = room.players.find((player) => player.id === submission.playerId);
      return {
        id: submission.id,
        text: submission.text,
        hidden: submission.hidden,
        votes: submission.votes.length,
        reports: submission.reports.length,
        authorNickname: author?.nickname || "알 수 없음"
      };
    })
  }));
}

function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    isPublic: room.isPublic,
    streamerMode: Boolean(room.streamerMode),
    hideRoomCode: Boolean(room.hideRoomCode),
    playerCount: connectedPlayers(room).length,
    totalPlayers: room.players.length,
    maxPlayers: room.settings.maxPlayers,
    roundIndex: room.roundIndex,
    totalRounds: room.settings.roundCount,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt
  };
}

function startCleanupInterval(io) {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    cleanupRooms(io);
  }, gameConfig.cleanupIntervalSeconds * 1000);

  cleanupInterval.unref?.();
}

function cleanupRooms(io) {
  const now = Date.now();
  const waitingLimitMs = gameConfig.waitingRoomCleanupMinutes * 60 * 1000;
  const finishedLimitMs = gameConfig.finishedRoomCleanupMinutes * 60 * 1000;

  for (const room of [...rooms.values()]) {
    pruneExpiredDisconnectedPlayers(room);

    if (room.players.length === 0) {
      deleteRoom(room.code);
      continue;
    }

    if (room.phase === "lobby" && now - room.lastActivityAt >= waitingLimitMs) {
      closeRoom(io, room, "대기 시간이 길어 방이 자동 정리되었습니다.");
      continue;
    }

    if (room.phase === "final" && room.finishedAt && now - room.finishedAt >= finishedLimitMs) {
      closeRoom(io, room, "종료된 방이 자동 정리되었습니다.");
    }
  }

  emitPublicRooms(io);
}

function closeRoom(io, room, message) {
  clearRoomTimer(room);
  for (const player of room.players) {
    if (!player.socketId) continue;
    io?.to(player.socketId).emit("room:closed", { message });
    io?.sockets.sockets.get(player.socketId)?.leave(room.code);
    playerBySocket.delete(player.socketId);
  }
  rooms.delete(room.code);
  logEvent("room_deleted", "Room deleted", { roomCode: room.code, metadata: { reason: message } });
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimer(room);
  for (const player of room.players) {
    if (player.socketId) playerBySocket.delete(player.socketId);
  }
  rooms.delete(code);
  logEvent("room_deleted", "Room deleted", { roomCode: code, metadata: { reason: "empty" } });
}

function logEvent(type, message, options = {}) {
  if (!prismaRef) return;
  prismaRef.adminLog.create({
    data: {
      type,
      message,
      roomCode: options.roomCode || null,
      actor: options.actor || null,
      metadataJson: options.metadata ? JSON.stringify(options.metadata) : null
    }
  }).catch((error) => {
    console.error("Failed to save admin log", error);
  });
}

function logServerError(message, error) {
  console.error(message, error);
  logEvent("server_error", message, {
    metadata: {
      error: error?.message || String(error)
    }
  });
}

async function handleAdminLogin(req, res) {
  const limit = checkAdminLoginRateLimit(req);
  if (!limit.ok) {
    writeJson(res, 429, {
      ok: false,
      error: `로그인 시도가 너무 많습니다. ${Math.ceil(limit.retryAfterMs / 60000)}분 후 다시 시도해 주세요.`
    });
    return;
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    logEvent("server_error", "ADMIN_PASSWORD is not configured");
    writeJson(res, 503, { ok: false, error: "ADMIN_PASSWORD가 설정되지 않았습니다." });
    return;
  }

  const body = await readJsonBody(req);
  const password = String(body?.password || "");
  if (!safeCompare(password, expected)) {
    recordFailedAdminLogin(req);
    logEvent("admin_login_failed", "Admin login failed", { actor: getRequestIp(req) });
    writeJson(res, 401, { ok: false, error: "관리자 비밀번호가 올바르지 않습니다." });
    return;
  }

  clearAdminLoginAttempts(req);
  const now = Date.now();
  const sessionId = crypto.randomBytes(32).toString("hex");
  adminSessions.set(sessionId, {
    createdAt: now,
    lastSeen: now,
    ip: getRequestIp(req)
  });
  setAdminSessionCookie(req, res, sessionId);
  logEvent("admin_login", "Admin logged in", { actor: getRequestIp(req) });
  writeJson(res, 200, { ok: true });
}

function handleAdminLogout(req, res) {
  const sessionId = getAdminSessionId(req);
  if (sessionId) adminSessions.delete(sessionId);
  clearAdminSessionCookie(req, res);
  logEvent("admin_logout", "Admin logged out", { actor: getRequestIp(req) });
  writeJson(res, 200, { ok: true });
}

function requireAdminPageSession(req, res) {
  return validateAdminSession(req, res).ok;
}

function validateAdminSession(req, res) {
  const sessionId = getAdminSessionId(req);
  if (!sessionId) return { ok: false, error: "Unauthorized" };

  const session = adminSessions.get(sessionId);
  if (!session) {
    clearAdminSessionCookie(req, res);
    return { ok: false, error: "Unauthorized" };
  }

  const now = Date.now();
  const timeoutMs = getAdminSessionTimeoutMs();
  if (now - session.lastSeen > timeoutMs) {
    adminSessions.delete(sessionId);
    clearAdminSessionCookie(req, res);
    return { ok: false, error: "관리자 세션이 만료되었습니다." };
  }

  session.lastSeen = now;
  setAdminSessionCookie(req, res, sessionId);
  return { ok: true, expiresAt: now + timeoutMs };
}

function getAdminSessionId(req) {
  return parseCookies(req)[ADMIN_SESSION_COOKIE] || "";
}

function getAdminSessionTimeoutMs() {
  return Math.max(1, Number(gameConfig.adminSessionTimeoutMinutes || 30)) * 60 * 1000;
}

function getAdminLoginRateLimitWindowMs() {
  return Math.max(1, Number(gameConfig.adminLoginRateLimitWindowMinutes || 10)) * 60 * 1000;
}

function getAdminLoginRateLimitMaxAttempts() {
  return Math.max(1, Number(gameConfig.adminLoginRateLimitMaxAttempts || 5));
}

function checkAdminLoginRateLimit(req) {
  const key = getRequestIp(req);
  const now = Date.now();
  const windowMs = getAdminLoginRateLimitWindowMs();
  const attempt = adminLoginAttempts.get(key);

  if (!attempt || now >= attempt.resetAt) {
    return { ok: true };
  }

  if (attempt.count >= getAdminLoginRateLimitMaxAttempts()) {
    return { ok: false, retryAfterMs: attempt.resetAt - now };
  }

  return { ok: true };
}

function recordFailedAdminLogin(req) {
  const key = getRequestIp(req);
  const now = Date.now();
  const windowMs = getAdminLoginRateLimitWindowMs();
  const existing = adminLoginAttempts.get(key);

  if (!existing || now >= existing.resetAt) {
    adminLoginAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  existing.count += 1;
}

function clearAdminLoginAttempts(req) {
  adminLoginAttempts.delete(getRequestIp(req));
}

function setAdminSessionCookie(req, res, sessionId) {
  res.setHeader("Set-Cookie", serializeCookie(ADMIN_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(getAdminSessionTimeoutMs() / 1000)
  }));
}

function clearAdminSessionCookie(req, res) {
  res.setHeader("Set-Cookie", serializeCookie(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax",
    path: "/",
    maxAge: 0
  }));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  return String(header).split(";").reduce((cookies, item) => {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex < 0) return cookies;
    const key = item.slice(0, separatorIndex).trim();
    const value = item.slice(separatorIndex + 1).trim();
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return forwardedProto === "https" || Boolean(req.socket?.encrypted);
}

function getRequestIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket?.remoteAddress || "unknown";
}

function safeCompare(value, expected) {
  const valueBuffer = Buffer.from(String(value));
  const expectedBuffer = Buffer.from(String(expected));
  if (valueBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function formatImageRecord(image) {
  return {
    ...image,
    tags: parseJsonArray(image.tagsJson)
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function reply(callback, ok, error, data = {}) {
  if (typeof callback === "function") {
    callback({ ok, error, ...data });
  }
}

module.exports = {
  handleAdminRequest,
  requireAdminPageSession,
  setupGameSocket
};
