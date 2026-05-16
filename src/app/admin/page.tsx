"use client";

import { FormEvent, useEffect, useState } from "react";

type AdminData = {
  rooms: AdminRoom[];
  reports: ReportRecord[];
  logs: AdminLog[];
  bannedWords: BannedWord[];
};

type AdminRoom = {
  code: string;
  name: string;
  phase: string;
  isPublic: boolean;
  playerCount: number;
  totalPlayers: number;
  roundIndex: number;
  totalRounds: number;
  players: AdminPlayer[];
  submissions: AdminSubmission[];
};

type AdminPlayer = {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
  isHost: boolean;
};

type AdminSubmission = {
  id: string;
  text: string;
  hidden: boolean;
  votes: number;
  reports: number;
  authorNickname: string;
};

type ReportRecord = {
  id: string;
  roomCode: string;
  roundIndex: number;
  captionText: string;
  authorNickname: string;
  reporterNickname: string;
  status: string;
  createdAt: string;
};

type AdminLog = {
  id: string;
  type: string;
  message: string;
  roomCode: string | null;
  actor: string | null;
  createdAt: string;
};

type BannedWord = {
  id: string;
  word: string;
};

export default function AdminPage() {
  const [data, setData] = useState<AdminData | null>(null);
  const [newWord, setNewWord] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    loadOverview();
  }, []);

  async function adminFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json();
    if (response.status === 401) {
      window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("관리자 세션이 만료되었습니다.");
    }
    if (!response.ok || !payload.ok) throw new Error(payload.error || "요청 실패");
    return payload;
  }

  async function loadOverview() {
    try {
      const payload = await adminFetch("/api/admin/overview");
      setData(payload);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "관리자 정보를 불러오지 못했습니다.");
    }
  }

  async function runAction(action: string, body: Record<string, unknown> = {}) {
    try {
      await adminFetch("/api/admin/action", {
        method: "POST",
        body: JSON.stringify({ action, ...body })
      });
      await loadOverview();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작업에 실패했습니다.");
    }
  }

  function submitWord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newWord.trim()) return;
    runAction("addBannedWord", { word: newWord.trim() });
    setNewWord("");
  }

  async function logout() {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });
    window.location.href = "/admin/login";
  }

  return (
    <main className="app-shell admin-shell">
      <header className="admin-header">
        <div>
          <h1>관리자</h1>
          <p>방 상태, 신고, 로그, 금칙어를 관리합니다.</p>
        </div>
        <div className="admin-header-actions">
          <a className="ghost-link" href="/admin/images">이미지 관리</a>
          <button type="button" className="ghost-button" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="admin-toolbar">
        <button type="button" className="ghost-button" onClick={() => loadOverview()}>
          새로고침
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      {data && (
        <section className="admin-grid">
          <section className="panel admin-panel">
            <h2>현재 방</h2>
            <div className="admin-list">
              {data.rooms.length === 0 ? (
                <div className="empty-state">진행 중인 방이 없습니다.</div>
              ) : data.rooms.map((room) => (
                <div className="admin-room" key={room.code}>
                  <div className="admin-room-head">
                    <strong>{room.name}</strong>
                    <span>{room.code} · {room.phase} · {room.isPublic ? "공개" : "비공개"}</span>
                    <button className="danger-mini-button" onClick={() => runAction("deleteRoom", { roomCode: room.code })}>
                      방 삭제
                    </button>
                  </div>
                  <div className="admin-mini-list">
                    {room.players.map((player) => (
                      <div className="admin-mini-row" key={player.id}>
                        <span>{player.nickname} {player.isHost ? "· 방장" : ""} · {player.connected ? "접속" : "끊김"} · {player.score}점</span>
                        <button className="danger-mini-button" onClick={() => runAction("removePlayer", { roomCode: room.code, playerId: player.id })}>
                          퇴장
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="admin-mini-list">
                    {room.submissions.map((submission) => (
                      <div className="admin-mini-row" key={submission.id}>
                        <span>{submission.hidden ? "[숨김] " : ""}{submission.text} · {submission.authorNickname} · 신고 {submission.reports}</span>
                        <button
                          className={submission.hidden ? "secondary-button" : "danger-mini-button"}
                          onClick={() => runAction("setSubmissionHidden", {
                            roomCode: room.code,
                            submissionId: submission.id,
                            hidden: !submission.hidden
                          })}
                        >
                          {submission.hidden ? "복구" : "숨김"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel admin-panel">
            <h2>신고 기록</h2>
            <div className="admin-list">
              {data.reports.map((report) => (
                <div className="admin-report" key={report.id}>
                  <strong>{report.captionText}</strong>
                  <span>작성자 {report.authorNickname} · 신고자 {report.reporterNickname}</span>
                  <span>{report.roomCode} · R{report.roundIndex} · {report.status} · {formatDate(report.createdAt)}</span>
                  <div className="admin-actions">
                    <button className="danger-mini-button" onClick={() => runAction("setReportStatus", { reportId: report.id, status: "hidden" })}>
                      숨김
                    </button>
                    <button className="ghost-button" onClick={() => runAction("setReportStatus", { reportId: report.id, status: "dismissed" })}>
                      기각
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel admin-panel">
            <h2>금칙어</h2>
            <form className="admin-inline-form" onSubmit={submitWord}>
              <input value={newWord} onChange={(event) => setNewWord(event.target.value)} placeholder="추가할 금칙어" />
              <button className="primary-button">추가</button>
            </form>
            <div className="tag-list">
              {data.bannedWords.map((word) => (
                <button key={word.id} className="tag-button" onClick={() => runAction("deleteBannedWord", { id: word.id })}>
                  {word.word} ×
                </button>
              ))}
            </div>
          </section>

          <section className="panel admin-panel">
            <h2>최근 로그</h2>
            <div className="admin-list">
              {data.logs.map((log) => (
                <div className="log-row" key={log.id}>
                  <strong>{log.type}</strong>
                  <span>{log.message}</span>
                  <span>{log.roomCode || "-"} · {log.actor || "-"} · {formatDate(log.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </section>
      )}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
