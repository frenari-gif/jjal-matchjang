"use client";

import { FormEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type Phase = "lobby" | "caption" | "reveal" | "voting" | "results" | "final";

type GameSettings = {
  roundCount: number;
  captionSeconds: number;
  voteSeconds: number;
  minPlayers: number;
  maxPlayers: number;
};

type Player = {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
  isHost: boolean;
  submitted: boolean;
  voted: boolean;
};

type Submission = {
  id: string;
  text: string;
  votes: number;
  hidden: boolean;
  reportCount: number;
  reportedByMe: boolean;
  authorId: string | null;
  authorName: string | null;
  mine: boolean;
  votedByMe: boolean;
};

type ChatMessage = {
  id: string;
  type: "player" | "system";
  roomCode: string;
  playerId: string | null;
  playerSessionId: string | null;
  nickname: string;
  message: string;
  createdAt: number;
  mine: boolean;
};

type PlayerProfile = {
  nickname: string;
  totalPlayedGames: number;
  totalPlayedRounds: number;
  totalWonGames: number;
  totalRoundWins: number;
  totalVotesReceived: number;
  totalCaptionsSubmitted: number;
  averageVotesReceived: number;
  lastSeenAt: string;
  createdAt: string;
};

type RoomState = {
  code: string;
  name: string;
  isPublic: boolean;
  phase: Phase;
  hostId: string;
  currentPlayerId: string;
  settings: GameSettings;
  players: Player[];
  roundIndex: number;
  totalRounds: number;
  image: { src: string; name: string } | null;
  submissions: Submission[];
  chatMessages: ChatMessage[];
  mySubmissionId: string | null;
  myVoteSubmissionId: string | null;
  endsAt: number | null;
  serverNow: number;
  canStart: boolean;
  winnerIds: string[];
};

type PublicRoom = {
  code: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  roundCount: number;
  captionSeconds: number;
  status: string;
  isFull: boolean;
};

type ServerAck = {
  ok: boolean;
  error?: string;
  state?: RoomState;
  profile?: PlayerProfile;
};

type NoticeTone = "info" | "error" | "success";
type BusyAction = "connect" | "join" | "create" | "quickJoin" | "start" | "caption" | "vote" | "next" | null;

const PLAYER_SESSION_STORAGE = "jjal-matchjang:player-session-id";
const LAST_ROOM_STORAGE = "jjal-matchjang:last-room-code";

const DEFAULT_SETTINGS: GameSettings = {
  roundCount: 5,
  captionSeconds: 45,
  voteSeconds: 25,
  minPlayers: 2,
  maxPlayers: 8
};

const PHASE_LABEL: Record<Phase, string> = {
  lobby: "대기방",
  caption: "제목 작성",
  reveal: "익명 제목 공개",
  voting: "투표",
  results: "라운드 결과",
  final: "최종 결과"
};

const BUSY_MESSAGE: Record<Exclude<BusyAction, null>, string> = {
  connect: "서버에 연결 중입니다.",
  join: "방에 입장 중입니다.",
  create: "방을 만드는 중입니다.",
  quickJoin: "참가 가능한 공개방을 찾는 중입니다.",
  start: "게임을 시작하는 중입니다.",
  caption: "제목을 제출하는 중입니다.",
  vote: "투표 결과를 집계하는 중입니다.",
  next: "다음 라운드를 준비 중입니다."
};

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [nickname, setNickname] = useState("");
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [isPublic, setIsPublic] = useState(true);
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [caption, setCaption] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const [busyAction, setBusyAction] = useState<BusyAction>("connect");
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const roomNameInputRef = useRef<HTMLInputElement>(null);
  const captionInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const lastChatRoomRef = useRef("");
  const lastChatCountRef = useRef(0);
  const lastChatMessageIdRef = useRef("");

  useEffect(() => {
    const savedNickname = window.localStorage.getItem("jjal-matchjang:nickname");
    if (savedNickname) {
      setNickname(savedNickname);
      setRoomName(`${savedNickname}의 방`);
    }
    getOrCreatePlayerSessionId();

    const nextSocket = io({
      transports: ["websocket", "polling"]
    });

    nextSocket.on("connect", () => {
      setConnected(true);
      setBusyAction("connect");
      const roomCode = window.localStorage.getItem(LAST_ROOM_STORAGE);
      const playerSessionId = getOrCreatePlayerSessionId();
      if (roomCode && playerSessionId) {
        nextSocket.emit("room:reconnect", { roomCode, playerSessionId }, (response: ServerAck) => {
          setBusyAction(null);
          if (response?.ok && response.state) {
            showNotice("이전 방으로 재접속했습니다.", "success");
            setRoomState(response.state);
            return;
          }

          window.localStorage.removeItem(LAST_ROOM_STORAGE);
          showNotice("이전 방으로 복귀할 수 없습니다. 방이 삭제되었거나 재접속 시간이 지났습니다.", "info");
          nextSocket.emit("rooms:list");
        });
        return;
      }
      setBusyAction(null);
      showNotice("", "info");
      nextSocket.emit("rooms:list");
    });

    nextSocket.on("disconnect", () => {
      setConnected(false);
      setBusyAction("connect");
      showNotice("서버 연결이 끊겼습니다. 자동으로 다시 연결을 시도합니다.", "error");
    });

    nextSocket.on("rooms:list", (rooms: PublicRoom[]) => {
      setPublicRooms(rooms);
      setRoomsLoaded(true);
    });

    nextSocket.on("room:state", (state: RoomState) => {
      setRoomState(state);
      setBusyAction(null);
      setClockOffset(state.serverNow - Date.now());
      window.localStorage.setItem(LAST_ROOM_STORAGE, state.code);
      if (state.phase !== "caption") setCaption("");
    });

    nextSocket.on("room:kicked", (payload: { message?: string }) => {
      setRoomState(null);
      window.localStorage.removeItem(LAST_ROOM_STORAGE);
      showNotice(payload?.message || "방장에 의해 강퇴되었습니다.", "error");
      nextSocket.emit("rooms:list");
    });

    nextSocket.on("room:closed", (payload: { message?: string }) => {
      setRoomState(null);
      window.localStorage.removeItem(LAST_ROOM_STORAGE);
      showNotice(payload?.message || "방이 삭제되었거나 정리되었습니다.", "error");
      nextSocket.emit("rooms:list");
    });

    setSocket(nextSocket);

    return () => {
      nextSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const timer = window.setInterval(() => socket.emit("rooms:list"), 3000);
    return () => window.clearInterval(timer);
  }, [socket]);

  useEffect(() => {
    if (roomState?.phase === "caption" && !roomState.mySubmissionId) {
      captionInputRef.current?.focus();
    }
  }, [roomState?.mySubmissionId, roomState?.phase]);

  useEffect(() => {
    if (!roomState) {
      lastChatRoomRef.current = "";
      lastChatCountRef.current = 0;
      lastChatMessageIdRef.current = "";
      setUnreadChatCount(0);
      return;
    }

    const messages = roomState.chatMessages || [];
    const latestMessageId = messages[messages.length - 1]?.id || "";
    if (lastChatRoomRef.current !== roomState.code) {
      lastChatRoomRef.current = roomState.code;
      lastChatCountRef.current = messages.length;
      lastChatMessageIdRef.current = latestMessageId;
      setUnreadChatCount(0);
      window.setTimeout(() => chatEndRef.current?.scrollIntoView({ block: "end" }), 0);
      return;
    }

    const addedCount = latestMessageId && latestMessageId !== lastChatMessageIdRef.current
      ? Math.max(1, messages.length - lastChatCountRef.current)
      : 0;
    lastChatCountRef.current = messages.length;
    lastChatMessageIdRef.current = latestMessageId;

    if (addedCount > 0 && chatCollapsed) {
      setUnreadChatCount((previous) => previous + addedCount);
    }

    if (!chatCollapsed) {
      setUnreadChatCount(0);
      window.setTimeout(() => chatEndRef.current?.scrollIntoView({ block: "end" }), 0);
    }
  }, [chatCollapsed, roomState]);

  const secondsLeft = useMemo(() => {
    if (!roomState?.endsAt) return null;
    return Math.max(0, Math.ceil((roomState.endsAt - (now + clockOffset)) / 1000));
  }, [clockOffset, now, roomState?.endsAt]);

  const currentPlayer = roomState?.players.find((player) => player.id === roomState.currentPlayerId) || null;
  const isHost = Boolean(currentPlayer?.isHost);
  const sortedPlayers = useMemo(() => {
    return [...(roomState?.players || [])].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.nickname.localeCompare(b.nickname, "ko");
    });
  }, [roomState?.players]);

  function persistNickname(value: string) {
    setNickname(value);
    window.localStorage.setItem("jjal-matchjang:nickname", value);
    if (!roomName.trim()) setRoomName(`${value.trim()}의 방`);
  }

  function showNotice(message: string, tone: NoticeTone = "info") {
    setNotice(message);
    setNoticeTone(tone);
  }

  function getFriendlyError(error?: string) {
    if (!error) return "요청 처리에 실패했습니다.";
    if (error.includes("방을 찾을 수 없습니다")) return "잘못된 방 코드이거나 삭제된 방입니다.";
    if (error.includes("이미 시작된 방")) return "이미 게임 중인 방이라 입장할 수 없습니다.";
    if (error.includes("방이 가득")) return "방이 가득 차서 입장할 수 없습니다.";
    if (error.includes("강퇴")) return "방장에 의해 강퇴된 방에는 다시 입장할 수 없습니다.";
    if (error.includes("닉네임")) return "닉네임을 2~16자로 입력해 주세요.";
    if (error.includes("최소")) return "플레이어가 부족해 아직 시작할 수 없습니다.";
    if (error.includes("채팅")) return error;
    if (error.includes("금칙어")) return error;
    return error;
  }

  function ensureConnected() {
    if (socket && connected) return true;
    showNotice("서버에 연결된 뒤 다시 시도해 주세요.", "error");
    return false;
  }

  function handleAck(response: ServerAck) {
    setBusyAction(null);
    if (!response?.ok) {
      showNotice(getFriendlyError(response?.error), "error");
      return;
    }
    showNotice("", "info");
    if (response.state) setRoomState(response.state);
  }

  function createRoom() {
    if (!ensureConnected()) return;
    setBusyAction("create");
    socket?.emit("room:create", {
      nickname,
      roomName,
      settings,
      isPublic,
      playerSessionId: getOrCreatePlayerSessionId()
    }, handleAck);
  }

  function joinRoom(code = joinCode) {
    if (!ensureConnected()) return;
    if (!code.trim()) {
      showNotice("입장할 방 코드를 입력해 주세요.", "error");
      return;
    }
    setBusyAction("join");
    socket?.emit("room:join", {
      nickname,
      code,
      playerSessionId: getOrCreatePlayerSessionId()
    }, handleAck);
  }

  function quickJoin() {
    if (!ensureConnected()) return;
    setBusyAction("quickJoin");
    socket?.emit("room:quickJoin", {
      nickname,
      playerSessionId: getOrCreatePlayerSessionId()
    }, handleAck);
  }

  function leaveRoom() {
    socket?.emit("room:leave");
    setRoomState(null);
    window.localStorage.removeItem(LAST_ROOM_STORAGE);
    showNotice("", "info");
    socket?.emit("rooms:list");
  }

  function startGame() {
    if (!ensureConnected()) return;
    if (roomState && !roomState.canStart) {
      showNotice(`최소 ${roomState.settings.minPlayers}명이 모여야 시작할 수 있습니다.`, "error");
      return;
    }
    setBusyAction("start");
    socket?.emit("game:start", handleAck);
  }

  function kickPlayer(playerId: string) {
    if (!ensureConnected()) return;
    socket?.emit("room:kick", { targetPlayerId: playerId }, handleAck);
  }

  function submitCaption(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ensureConnected()) return;
    if (!caption.trim()) {
      showNotice("제목을 입력해 주세요.", "error");
      return;
    }
    setBusyAction("caption");
    socket?.emit("caption:submit", { text: caption }, handleAck);
  }

  function reportCaption(submissionId: string) {
    if (!ensureConnected()) return;
    socket?.emit("caption:report", { submissionId }, handleAck);
  }

  function submitVote(submissionId: string) {
    if (!ensureConnected()) return;
    setBusyAction("vote");
    socket?.emit("vote:submit", { submissionId }, handleAck);
  }

  function nextRound() {
    if (!ensureConnected()) return;
    setBusyAction("next");
    socket?.emit("game:nextRound", handleAck);
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ensureConnected() || !roomState) return;
    const message = chatDraft.trim();
    if (!message) {
      showNotice("채팅 메시지를 입력해 주세요.", "error");
      return;
    }

    socket?.emit("chat:send", {
      roomCode: roomState.code,
      playerSessionId: getOrCreatePlayerSessionId(),
      message
    }, (response: ServerAck) => {
      if (!response?.ok) {
        showNotice(getFriendlyError(response?.error), "error");
        return;
      }
      setChatDraft("");
      showNotice("", "info");
    });
  }

  function toggleChatCollapsed() {
    setChatCollapsed((previous) => {
      const next = !previous;
      if (!next) {
        setUnreadChatCount(0);
        window.setTimeout(() => chatEndRef.current?.scrollIntoView({ block: "end" }), 0);
      }
      return next;
    });
  }

  function handleProfileAck(response: ServerAck) {
    setProfileLoading(false);
    if (!response?.ok || !response.profile) {
      showNotice(getFriendlyError(response?.error), "error");
      return;
    }

    setProfile(response.profile);
    showNotice("", "info");
  }

  function openMyProfile() {
    if (!ensureConnected()) return;
    setProfile(null);
    setProfileLoading(true);
    socket?.emit("profile:mine", {
      playerSessionId: getOrCreatePlayerSessionId(),
      nickname
    }, handleProfileAck);
  }

  function openPlayerProfile(playerId: string) {
    if (!ensureConnected() || !roomState) return;
    setProfile(null);
    setProfileLoading(true);
    socket?.emit("profile:get", {
      roomCode: roomState.code,
      playerId,
      playerSessionId: getOrCreatePlayerSessionId()
    }, handleProfileAck);
  }

  function focusRoomName() {
    setIsPublic(true);
    window.setTimeout(() => roomNameInputRef.current?.focus(), 0);
  }

  function updateSetting(key: keyof GameSettings, value: string) {
    setSettings((previous) => ({
      ...previous,
      [key]: Number(value)
    }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="" className="brand-logo" />
          <div>
            <h1>짤맞짱</h1>
            <p>실시간 멀티 짤 제목 대결</p>
          </div>
        </div>
        <div className={connected ? "connection is-online" : "connection"}>
          {connected ? "Socket 연결됨" : "연결 중"}
        </div>
      </header>

      {!connected && (
        <StatusBanner
          tone="info"
          title="서버 연결 중"
          message="서버에 연결되는 동안 방 만들기와 입장이 잠시 비활성화됩니다."
        />
      )}
      {notice && (
        <StatusBanner
          tone={noticeTone}
          title={noticeTone === "error" ? "확인 필요" : "안내"}
          message={notice}
          onDismiss={() => showNotice("", "info")}
        />
      )}
      {busyAction && <LoadingStrip message={BUSY_MESSAGE[busyAction]} />}

      {!roomState ? (
        <section className="home-grid">
          <div className="panel">
            <div className="panel-heading">
              <h2>입장</h2>
              <span>PC 웹 MVP</span>
            </div>

            <label className="field">
              <span>닉네임</span>
              <input
                ref={nicknameInputRef}
                value={nickname}
                onChange={(event) => persistNickname(event.target.value)}
                maxLength={16}
                placeholder="2~16자"
                autoFocus
                aria-label="닉네임"
              />
            </label>

            <div className="join-row">
              <label className="field">
                <span>방 코드</span>
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  maxLength={8}
                  placeholder="ABC123"
                  aria-label="방 코드"
                />
              </label>
              <button className="primary-button" onClick={() => joinRoom()} disabled={!connected || Boolean(busyAction)}>
                {busyAction === "join" ? "입장 중" : "코드 입장"}
              </button>
            </div>

            <button className="secondary-button full" onClick={quickJoin} disabled={!connected || Boolean(busyAction)}>
              {busyAction === "quickJoin" ? "찾는 중" : "빠른 참가"}
            </button>
            <button className="ghost-button full profile-button" onClick={openMyProfile} disabled={!connected}>
              내 정보
            </button>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>방 만들기</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(event) => setIsPublic(event.target.checked)}
                />
                공개방
              </label>
            </div>

            <label className="field room-name-field">
              <span>방 이름</span>
              <input
                ref={roomNameInputRef}
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                maxLength={24}
                placeholder="내 공개 테스트방"
                aria-label="방 이름"
              />
            </label>

            <div className="settings-grid">
              <NumberField label="라운드" min={1} max={20} value={settings.roundCount} onChange={(value) => updateSetting("roundCount", value)} />
              <NumberField label="제목 시간" min={5} max={120} value={settings.captionSeconds} onChange={(value) => updateSetting("captionSeconds", value)} />
              <NumberField label="투표 시간" min={5} max={60} value={settings.voteSeconds} onChange={(value) => updateSetting("voteSeconds", value)} />
              <NumberField label="최소 인원" min={2} max={10} value={settings.minPlayers} onChange={(value) => updateSetting("minPlayers", value)} />
              <NumberField label="최대 인원" min={2} max={20} value={settings.maxPlayers} onChange={(value) => updateSetting("maxPlayers", value)} />
            </div>

            <button className="primary-button full" onClick={createRoom} disabled={!connected || Boolean(busyAction)}>
              {busyAction === "create" ? "생성 중" : "방 만들기"}
            </button>
          </div>

          <div className="panel public-panel">
            <div className="panel-heading">
              <h2>공개방 목록</h2>
              <span>{publicRooms.length}개</span>
            </div>

            <div className="room-list">
              {publicRooms.length === 0 ? (
                <EmptyState
                  title={roomsLoaded ? "참가 가능한 공개방이 없습니다" : "공개방을 불러오는 중입니다"}
                  description={roomsLoaded ? "새 공개방을 만들거나 방 코드를 받아 비공개방에 입장하세요." : "잠시만 기다려 주세요."}
                >
                  {roomsLoaded && (
                    <button className="secondary-button empty-action" onClick={focusRoomName}>
                      공개방 만들기
                    </button>
                  )}
                </EmptyState>
              ) : (
                publicRooms.map((room) => (
                  <button
                    className={room.isFull ? "room-card is-full" : "room-card"}
                    key={room.code}
                    onClick={() => joinRoom(room.code)}
                    disabled={room.isFull || Boolean(busyAction)}
                  >
                    <strong>{room.name}</strong>
                    <span className="room-meta">
                      {room.playerCount}/{room.maxPlayers}명 · {room.roundCount}R · 제목 {room.captionSeconds}초
                    </span>
                    <span className={room.isFull ? "status-pill is-full" : "status-pill"}>
                      {room.isFull ? "입장 불가" : room.status}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="game-grid">
          <aside className="panel sidebar">
            <div className="room-code">
              <span>{roomState.name}</span>
              <strong>{roomState.code}</strong>
            </div>
            <div className="phase-badge">{PHASE_LABEL[roomState.phase]}</div>
            {secondsLeft !== null && <div className="timer">{secondsLeft}s</div>}

            <div className="scoreboard">
              <h2>점수판</h2>
              {sortedPlayers.map((player) => (
                <div className="score-row" key={player.id}>
                  <div className="score-row-main">
                    <span>
                      {player.nickname}
                      {player.isHost ? " · 방장" : ""}
                      {!player.connected ? " · 오프라인" : ""}
                    </span>
                    <strong>{player.score}</strong>
                  </div>
                  {isHost && player.id !== roomState.currentPlayerId && player.connected && (
                    <button className="danger-mini-button" onClick={() => kickPlayer(player.id)}>
                      강퇴
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button className="ghost-button full" onClick={openMyProfile}>
              내 정보
            </button>
            <button className="ghost-button full" onClick={leaveRoom}>
              나가기
            </button>
          </aside>

          <section className="panel game-panel">
            <div className="round-header">
              <div>
                <span>라운드</span>
                <strong>
                  {Math.min(roomState.roundIndex || 1, roomState.totalRounds)} / {roomState.totalRounds}
                </strong>
              </div>
              <div>
                <span>인원</span>
                <strong>
                  {roomState.players.filter((player) => player.connected).length} / {roomState.settings.maxPlayers}
                </strong>
              </div>
            </div>

            {roomState.phase === "lobby" && (
              <LobbyView
                roomState={roomState}
                isHost={isHost}
                isBusy={Boolean(busyAction)}
                onStart={startGame}
                onKick={kickPlayer}
                onViewProfile={openPlayerProfile}
              />
            )}

            {roomState.phase !== "lobby" && roomState.phase !== "final" && (
              <ImageStage roomState={roomState} />
            )}

            {roomState.phase === "caption" && (
              <form className="caption-form" onSubmit={submitCaption}>
                <input
                  ref={captionInputRef}
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  maxLength={60}
                  placeholder={roomState.mySubmissionId ? "제출 완료" : "제목을 입력하세요"}
                  disabled={Boolean(roomState.mySubmissionId)}
                  aria-label="제목 입력"
                />
                <button className="primary-button" disabled={Boolean(roomState.mySubmissionId) || Boolean(busyAction)}>
                  {busyAction === "caption" ? "제출 중" : "제목 제출"}
                </button>
              </form>
            )}

            {roomState.phase === "reveal" && (
              <SubmissionList roomState={roomState} mode="reveal" isBusy={Boolean(busyAction)} onVote={submitVote} onReport={reportCaption} />
            )}

            {roomState.phase === "voting" && (
              <SubmissionList roomState={roomState} mode="voting" isBusy={Boolean(busyAction)} onVote={submitVote} onReport={reportCaption} />
            )}

            {roomState.phase === "results" && (
              <>
                <SubmissionList roomState={roomState} mode="results" isBusy={Boolean(busyAction)} onVote={submitVote} onReport={reportCaption} />
                {isHost && (
                  <button className="primary-button next-button" onClick={nextRound} disabled={Boolean(busyAction)}>
                    {busyAction === "next"
                      ? "준비 중"
                      : roomState.roundIndex >= roomState.totalRounds
                        ? "최종 결과 보기"
                        : "다음 라운드"}
                  </button>
                )}
              </>
            )}

            {roomState.phase === "final" && <FinalView roomState={roomState} />}
          </section>

          <ChatPanel
            messages={roomState.chatMessages || []}
            draft={chatDraft}
            collapsed={chatCollapsed}
            unreadCount={unreadChatCount}
            chatEndRef={chatEndRef}
            onDraftChange={setChatDraft}
            onSubmit={submitChat}
            onToggle={toggleChatCollapsed}
          />
        </section>
      )}
      {(profile || profileLoading) && (
        <ProfileModal
          profile={profile}
          loading={profileLoading}
          onClose={() => {
            setProfile(null);
            setProfileLoading(false);
          }}
        />
      )}
    </main>
  );
}

function getOrCreatePlayerSessionId() {
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(PLAYER_SESSION_STORAGE);
  if (existing) return existing;

  const nextKey = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(PLAYER_SESSION_STORAGE, nextKey);
  return nextKey;
}

function StatusBanner({
  tone,
  title,
  message,
  onDismiss
}: {
  tone: NoticeTone;
  title: string;
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className={`status-banner is-${tone}`} role="status" aria-live="polite">
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button type="button" className="status-dismiss" onClick={onDismiss} aria-label="안내 닫기">
          닫기
        </button>
      )}
    </div>
  );
}

function LoadingStrip({ message }: { message: string }) {
  return (
    <div className="loading-strip" role="status" aria-live="polite">
      <span className="loading-dot" />
      {message}
    </div>
  );
}

function EmptyState({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{description}</span>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

function ChatPanel({
  messages,
  draft,
  collapsed,
  unreadCount,
  chatEndRef,
  onDraftChange,
  onSubmit,
  onToggle
}: {
  messages: ChatMessage[];
  draft: string;
  collapsed: boolean;
  unreadCount: number;
  chatEndRef: RefObject<HTMLDivElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: () => void;
}) {
  return (
    <aside className={collapsed ? "panel chat-panel is-collapsed" : "panel chat-panel"}>
      <div className="chat-header">
        <div>
          <h2>방 채팅</h2>
          <span>{messages.length} / 50</span>
        </div>
        <button type="button" className="ghost-button chat-toggle" onClick={onToggle}>
          {collapsed ? "펼치기" : "접기"}
          {collapsed && unreadCount > 0 && <strong>{unreadCount}</strong>}
        </button>
      </div>

      {!collapsed && (
        <div className="chat-body">
          <div className="chat-messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">아직 채팅이 없습니다.</div>
            ) : messages.map((message) => (
              <div
                className={[
                  "chat-message",
                  message.type === "system" ? "is-system" : "",
                  message.mine ? "is-mine" : ""
                ].filter(Boolean).join(" ")}
                key={message.id}
              >
                {message.type === "system" ? (
                  <span>{message.message}</span>
                ) : (
                  <>
                    <div className="chat-message-meta">
                      <strong>{message.mine ? "나" : message.nickname}</strong>
                      <time>{formatChatTime(message.createdAt)}</time>
                    </div>
                    <p>{message.message}</p>
                  </>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <form className="chat-form" onSubmit={onSubmit}>
            <input
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              maxLength={100}
              placeholder="메시지 입력"
              aria-label="채팅 메시지"
            />
            <button className="primary-button" disabled={!draft.trim()}>
              전송
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}

function formatChatTime(value: number) {
  return new Intl.DateTimeFormat("ko", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function ProfileModal({
  profile,
  loading,
  onClose
}: {
  profile: PlayerProfile | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="profile-modal-backdrop" role="presentation">
      <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
        <div className="profile-modal-head">
          <div>
            <span>플레이어 기록</span>
            <h2 id="profile-modal-title">{profile?.nickname || "불러오는 중"}</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>

        {loading ? (
          <LoadingStrip message="플레이어 정보를 불러오는 중입니다." />
        ) : profile ? (
          <>
            <div className="profile-grid">
              <ProfileStat label="총 플레이 게임" value={`${profile.totalPlayedGames}게임`} />
              <ProfileStat label="총 승리 게임" value={`${profile.totalWonGames}승`} />
              <ProfileStat label="총 플레이 라운드" value={`${profile.totalPlayedRounds}라운드`} />
              <ProfileStat label="총 라운드 승리" value={`${profile.totalRoundWins}승`} />
              <ProfileStat label="총 받은 투표" value={`${profile.totalVotesReceived}표`} />
              <ProfileStat label="총 제출 제목" value={`${profile.totalCaptionsSubmitted}개`} />
              <ProfileStat label="평균 받은 투표" value={`${profile.averageVotesReceived.toFixed(2)}표`} />
              <ProfileStat label="마지막 접속" value={formatProfileDate(profile.lastSeenAt)} />
            </div>
          </>
        ) : (
          <EmptyState title="플레이어 정보를 찾을 수 없습니다" description="잠시 후 다시 시도해 주세요." />
        )}
      </section>
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="profile-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatProfileDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function NumberField({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function LobbyView({
  roomState,
  isHost,
  isBusy,
  onStart,
  onKick,
  onViewProfile
}: {
  roomState: RoomState;
  isHost: boolean;
  isBusy: boolean;
  onStart: () => void;
  onKick: (playerId: string) => void;
  onViewProfile: (playerId: string) => void;
}) {
  return (
    <div className="lobby">
      <div className="lobby-main">
        <h2>대기방</h2>
        <div className="player-grid">
          {roomState.players.map((player) => (
            <div className="player-card" key={player.id}>
              <strong>{player.nickname}</strong>
              <span>{player.isHost ? "방장" : "참가자"}</span>
              <button className="secondary-mini-button" onClick={() => onViewProfile(player.id)}>
                정보 보기
              </button>
              {isHost && player.id !== roomState.currentPlayerId && player.connected && (
                <button className="danger-mini-button" onClick={() => onKick(player.id)}>
                  강퇴
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="settings-summary">
        <span>{roomState.settings.roundCount}라운드</span>
        <span>제목 {roomState.settings.captionSeconds}초</span>
        <span>투표 {roomState.settings.voteSeconds}초</span>
        <span>시작 {roomState.settings.minPlayers}명</span>
      </div>
      {isHost && !roomState.canStart && (
        <EmptyState
          title="플레이어가 부족합니다"
          description={`최소 ${roomState.settings.minPlayers}명이 접속해야 게임을 시작할 수 있습니다.`}
        />
      )}
      {isHost ? (
        <button className="primary-button full" onClick={onStart} disabled={!roomState.canStart || isBusy}>
          {isBusy ? "처리 중" : "게임 시작"}
        </button>
      ) : (
        <EmptyState title="방장 대기 중" description="방장이 게임을 시작할 때까지 기다려 주세요." />
      )}
    </div>
  );
}

function ImageStage({ roomState }: { roomState: RoomState }) {
  return (
    <div className="image-stage">
      {roomState.image ? (
        <img src={roomState.image.src} alt="라운드 이미지" />
      ) : (
        <EmptyState
          title="등록된 이미지가 없습니다"
          description="관리자 이미지 페이지에서 이미지를 추가하거나 활성화해 주세요."
        >
          <a className="ghost-link" href="/admin/images">
            이미지 관리
          </a>
        </EmptyState>
      )}
    </div>
  );
}

function SubmissionList({
  roomState,
  mode,
  isBusy,
  onVote,
  onReport
}: {
  roomState: RoomState;
  mode: "reveal" | "voting" | "results";
  isBusy: boolean;
  onVote: (submissionId: string) => void;
  onReport: (submissionId: string) => void;
}) {
  if (roomState.submissions.length === 0) {
    return <EmptyState title="제출된 제목이 없습니다" description="제목 작성 시간이 끝나면 다음 단계로 넘어갑니다." />;
  }

  return (
    <div className="submission-list">
      {roomState.submissions.map((submission, index) => {
        const canVote = mode === "voting" && !submission.mine && !roomState.myVoteSubmissionId && !submission.hidden;
        const canReport = !submission.mine && !submission.reportedByMe && !submission.hidden;

        return (
          <div
            className={[
              "submission-card",
              submission.votedByMe ? "is-selected" : "",
              submission.hidden ? "is-hidden" : ""
            ].filter(Boolean).join(" ")}
            key={submission.id}
          >
            <span className="submission-index">#{index + 1}</span>
            <strong className={submission.hidden ? "hidden-caption" : ""}>{submission.text}</strong>
            {mode === "results" ? (
              <span>
                {submission.authorName} · {submission.votes}표
              </span>
            ) : (
              <span>{submission.mine ? "내 제목" : "익명"}</span>
            )}
            <div className="submission-actions">
              {mode === "voting" && (
                <button className="vote-button" onClick={() => onVote(submission.id)} disabled={!canVote || isBusy}>
                  {isBusy ? "집계 중" : submission.votedByMe ? "투표 완료" : "투표"}
                </button>
              )}
              {!submission.mine && (
                <button className="report-button" onClick={() => onReport(submission.id)} disabled={!canReport || isBusy}>
                  {submission.hidden ? "숨김" : submission.reportedByMe ? "신고 완료" : "신고"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FinalView({ roomState }: { roomState: RoomState }) {
  const winners = roomState.players.filter((player) => roomState.winnerIds.includes(player.id));
  const sortedPlayers = [...roomState.players].sort((a, b) => b.score - a.score);

  return (
    <div className="final-view">
      <span>최종 승리</span>
      <h2>{winners.map((winner) => winner.nickname).join(", ") || "승자 없음"}</h2>
      <div className="final-board">
        {sortedPlayers.map((player, index) => (
          <div className="final-row" key={player.id}>
            <span>{index + 1}</span>
            <strong>{player.nickname}</strong>
            <em>{player.score}점</em>
          </div>
        ))}
      </div>
    </div>
  );
}
