"use client";

import { FormEvent, useState } from "react";

export default function AdminLoginPage() {
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setNotice("");

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error || "관리자 로그인에 실패했습니다.");
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      window.location.href = next && next.startsWith("/admin") && !next.startsWith("/admin/login") ? next : "/admin";
    } catch {
      setNotice("관리자 로그인 요청을 처리하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell admin-login-page">
      <section className="panel admin-login-card">
        <h1>관리자 로그인</h1>
        <p>관리자 기능을 사용하려면 비밀번호를 입력하세요.</p>

        <form className="admin-login-form" onSubmit={submitLogin}>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="ADMIN_PASSWORD"
            autoFocus
          />
          <button className="primary-button" disabled={loading || !password.trim()}>
            {loading ? "확인 중" : "로그인"}
          </button>
        </form>

        {notice && <div className="notice">{notice}</div>}
      </section>
    </main>
  );
}
