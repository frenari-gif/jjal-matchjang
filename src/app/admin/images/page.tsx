"use client";

import { FormEvent, useEffect, useState } from "react";

type GameImage = {
  id: string;
  src: string;
  title: string;
  tags: string[];
  enabled: boolean;
};

export default function AdminImagesPage() {
  const [images, setImages] = useState<GameImage[]>([]);
  const [src, setSrc] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadImages();
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

  async function loadImages() {
    try {
      const payload = await adminFetch("/api/admin/images");
      setImages(payload.images);
      setLoaded(true);
      setNotice("");
    } catch (error) {
      setLoaded(false);
      setNotice(error instanceof Error ? error.message : "이미지 목록을 불러오지 못했습니다.");
    }
  }

  async function runAction(action: string, body: Record<string, unknown>) {
    try {
      await adminFetch("/api/admin/action", {
        method: "POST",
        body: JSON.stringify({ action, ...body })
      });
      await loadImages();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작업에 실패했습니다.");
    }
  }

  function submitImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runAction("addImage", { src, title, tags, enabled: true });
    setSrc("");
    setTitle("");
    setTags("");
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
          <h1>이미지 관리</h1>
          <p>게임에 사용할 이미지 URL 또는 public/game-images 경로를 관리합니다.</p>
        </div>
        <div className="admin-header-actions">
          <a className="ghost-link" href="/admin">관리자 홈</a>
          <button type="button" className="ghost-button" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="admin-toolbar">
        <button type="button" className="ghost-button" onClick={() => loadImages()}>
          새로고침
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <section className="panel admin-panel">
        <h2>이미지 추가</h2>
        <p className="image-guidance">
          권장 비율은 16:9이며 1600x900 또는 1920x1080 이미지를 추천합니다. 파일을 직접 넣을 때는 public/game-images/user 폴더에 넣고 /game-images/user/파일명 경로로 등록하세요.
        </p>
        <form className="image-form" onSubmit={submitImage}>
          <input value={src} onChange={(event) => setSrc(event.target.value)} placeholder="/game-images/user/example.png 또는 https://..." />
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="제목" />
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="태그, 쉼표로 구분" />
          <button className="primary-button">추가</button>
        </form>
      </section>

      <section className="image-admin-grid">
        {!loaded ? (
          <div className="panel image-admin-card image-admin-empty">
            <strong>이미지 목록을 불러오는 중입니다</strong>
            <span>세션이 만료되면 로그인 페이지로 이동합니다.</span>
          </div>
        ) : images.length === 0 ? (
          <div className="panel image-admin-card image-admin-empty">
            <strong>등록된 이미지가 없습니다</strong>
            <span>이미지 URL 또는 public/game-images 경로를 등록하면 게임 라운드에 사용할 수 있습니다.</span>
          </div>
        ) : images.map((image) => (
          <div className="panel image-admin-card" key={image.id}>
            <div className="image-admin-preview">
              <img src={image.src} alt={image.title} />
            </div>
            <strong>{image.title}</strong>
            <span>{image.src}</span>
            <span>{image.tags.join(", ") || "태그 없음"}</span>
            <div className="admin-actions">
              <button
                className={image.enabled ? "secondary-button" : "primary-button"}
                onClick={() => runAction("updateImage", {
                  id: image.id,
                  title: image.title,
                  tags: image.tags,
                  enabled: !image.enabled
                })}
              >
                {image.enabled ? "비활성화" : "활성화"}
              </button>
              <button className="danger-mini-button" onClick={() => runAction("deleteImage", { id: image.id })}>
                삭제
              </button>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
