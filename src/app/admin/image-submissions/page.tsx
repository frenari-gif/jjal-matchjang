"use client";

import { useEffect, useState } from "react";

type ImageSubmission = {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  submittedByNickname: string;
  submittedBySessionId: string;
  status: "pending" | "approved" | "rejected";
  adminNote: string;
  createdAt: string;
  reviewedAt: string | null;
};

export default function AdminImageSubmissionsPage() {
  const [submissions, setSubmissions] = useState<ImageSubmission[]>([]);
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadSubmissions();
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

  async function loadSubmissions() {
    try {
      const payload = await adminFetch("/api/admin/image-submissions");
      setSubmissions(payload.submissions);
      setAdminNotes(Object.fromEntries(payload.submissions.map((item: ImageSubmission) => [item.id, item.adminNote || ""])));
      setLoaded(true);
      setNotice("");
    } catch (error) {
      setLoaded(false);
      setNotice(error instanceof Error ? error.message : "이미지 신청 목록을 불러오지 못했습니다.");
    }
  }

  async function reviewSubmission(id: string, status: "approved" | "rejected") {
    try {
      await adminFetch("/api/admin/action", {
        method: "POST",
        body: JSON.stringify({
          action: "reviewImageSubmission",
          id,
          status,
          adminNote: adminNotes[id] || ""
        })
      });
      await loadSubmissions();
      setNotice(status === "approved" ? "이미지 신청을 승인했습니다." : "이미지 신청을 기각했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "검토 처리에 실패했습니다.");
    }
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
          <h1>이미지 신청 검토</h1>
          <p>플레이어가 제출한 외부 이미지 URL을 승인하거나 기각합니다.</p>
        </div>
        <div className="admin-header-actions">
          <a className="ghost-link" href="/admin">관리자 홈</a>
          <a className="ghost-link" href="/admin/images">이미지 관리</a>
          <button type="button" className="ghost-button" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="admin-toolbar">
        <button type="button" className="ghost-button" onClick={() => loadSubmissions()}>
          새로고침
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <section className="image-admin-grid">
        {!loaded ? (
          <div className="panel image-admin-card image-admin-empty">
            <strong>이미지 신청 목록을 불러오는 중입니다</strong>
            <span>세션이 만료되면 로그인 페이지로 이동합니다.</span>
          </div>
        ) : submissions.length === 0 ? (
          <div className="panel image-admin-card image-admin-empty">
            <strong>검토할 이미지 신청이 없습니다</strong>
            <span>플레이어가 로비에서 이미지 추가 신청을 보내면 여기에 표시됩니다.</span>
          </div>
        ) : submissions.map((submission) => (
          <div className="panel image-admin-card image-submission-admin-card" key={submission.id}>
            <div className="image-admin-preview">
              <img src={submission.imageUrl} alt={submission.title || "신청 이미지"} />
            </div>
            <strong>{submission.title || "제목 없음"}</strong>
            <a href={submission.imageUrl} target="_blank" rel="noreferrer">{submission.imageUrl}</a>
            <span>{submission.description || "설명 없음"}</span>
            <span>신청자 {submission.submittedByNickname} · {formatDate(submission.createdAt)}</span>
            <span>상태 {formatStatus(submission.status)}{submission.reviewedAt ? ` · ${formatDate(submission.reviewedAt)}` : ""}</span>
            <textarea
              value={adminNotes[submission.id] || ""}
              onChange={(event) => setAdminNotes((previous) => ({ ...previous, [submission.id]: event.target.value }))}
              maxLength={300}
              placeholder="관리자 메모 선택"
            />
            <div className="admin-actions">
              <button
                className="primary-button"
                onClick={() => reviewSubmission(submission.id, "approved")}
                disabled={submission.status === "approved"}
              >
                승인
              </button>
              <button
                className="danger-mini-button"
                onClick={() => reviewSubmission(submission.id, "rejected")}
                disabled={submission.status === "rejected"}
              >
                기각
              </button>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

function formatStatus(status: ImageSubmission["status"]) {
  if (status === "approved") return "승인";
  if (status === "rejected") return "기각";
  return "대기";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
