const gameConfig = Object.freeze({
  reconnectGracePeriodSeconds: 180,
  adminRecentLogLimit: 100,
  adminSessionTimeoutMinutes: 30,
  adminLoginRateLimitWindowMinutes: 10,
  adminLoginRateLimitMaxAttempts: 5,
  defaultLoadTestUsers: 50,
  profileStatsMinPlayers: 3,
  maxChatMessageLength: 100,
  chatCooldownMs: 1000,
  maxChatHistoryPerRoom: 50,
  maxCaptionLength: 60,
  autoHideReportThreshold: 2,
  waitingRoomCleanupMinutes: 30,
  finishedRoomCleanupMinutes: 10,
  cleanupIntervalSeconds: 60
});

module.exports = { gameConfig };
