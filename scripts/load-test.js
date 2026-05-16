globalThis.URL = require("node:url").URL;
globalThis.URLSearchParams = require("node:url").URLSearchParams;
require.extensions[".ts"] = require.extensions[".js"];

const { io } = require("socket.io-client");
const { gameConfig } = require("../src/config/gameConfig.ts");

const endpoint = process.env.LOAD_TEST_URL || "http://localhost:3000";
const totalUsers = Number(process.env.LOAD_TEST_USERS || process.argv[2] || gameConfig.defaultLoadTestUsers);
const roomSize = Number(process.env.LOAD_TEST_ROOM_SIZE || 10);

const sockets = [];
const latestStateBySocket = new Map();

function connect(index) {
  return new Promise((resolve, reject) => {
    const socket = io(endpoint, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 8000
    });
    sockets.push(socket);
    const timeout = setTimeout(() => reject(new Error(`connect timeout ${index}`)), 10000);
    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.on("room:state", (state) => latestStateBySocket.set(socket.id, state));
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} ack timeout`)), 10000);
    const callback = (response) => {
      clearTimeout(timeout);
      if (!response?.ok) reject(new Error(`${event}: ${response?.error || "failed"}`));
      else resolve(response);
    };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  });
}

function waitForState(socket, predicate, label, timeoutMs = 15000) {
  const current = latestStateBySocket.get(socket.id);
  if (current && predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room:state", onState);
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    function onState(state) {
      if (predicate(state)) {
        clearTimeout(timeout);
        socket.off("room:state", onState);
        resolve(state);
      }
    }
    socket.on("room:state", onState);
  });
}

async function runGroup(groupIndex, count) {
  const groupSockets = [];
  for (let i = 0; i < count; i += 1) {
    groupSockets.push(await connect(groupIndex * roomSize + i));
  }

  const host = groupSockets[0];
  const created = await emitAck(host, "room:create", {
    nickname: `LT-${groupIndex}-0`,
    playerSessionId: `load-${Date.now()}-${groupIndex}-0`,
    roomName: `Load Test ${groupIndex}`,
    isPublic: false,
    settings: {
      roundCount: 1,
      captionSeconds: 5,
      voteSeconds: 5,
      minPlayers: 2,
      maxPlayers: Math.max(2, count)
    }
  });

  const code = created.state.code;
  for (let i = 1; i < groupSockets.length; i += 1) {
    await emitAck(groupSockets[i], "room:join", {
      nickname: `LT-${groupIndex}-${i}`,
      playerSessionId: `load-${Date.now()}-${groupIndex}-${i}`,
      code
    });
  }

  await emitAck(host, "game:start");
  await Promise.all(groupSockets.map((socket) => waitForState(socket, (state) => state.phase === "caption", "caption")));
  await Promise.all(groupSockets.map((socket, index) => {
    return emitAck(socket, "caption:submit", { text: `load caption ${groupIndex}-${index}` });
  }));

  const votingStates = await Promise.all(groupSockets.map((socket) => {
    return waitForState(socket, (state) => state.phase === "voting", "voting");
  }));

  await Promise.all(groupSockets.map((socket, index) => {
    const target = votingStates[index].submissions.find((submission) => !submission.mine && !submission.hidden);
    return target ? emitAck(socket, "vote:submit", { submissionId: target.id }) : Promise.resolve();
  }));

  await waitForState(host, (state) => state.phase === "results", "results");
  await emitAck(host, "game:nextRound");
  await waitForState(host, (state) => state.phase === "final", "final");

  return { code, users: count };
}

(async () => {
  const startedAt = Date.now();
  const groups = [];
  for (let remaining = totalUsers, groupIndex = 0; remaining > 0; groupIndex += 1) {
    const count = Math.min(roomSize, remaining);
    groups.push({ groupIndex, count });
    remaining -= count;
  }

  const results = [];
  for (const group of groups) {
    results.push(await runGroup(group.groupIndex, group.count));
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    users: totalUsers,
    rooms: results.length,
    elapsedMs: Date.now() - startedAt,
    results
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const socket of sockets) socket.disconnect();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
