import { useState, useRef, useEffect } from "react";

const TABS = ["タスク", "コメント", "インサイト"];

const mockComments = [
  { id: 1, user: "Ryo_fit", text: "がんばれ！！", time: "0:12", color: "#ff6b35" },
  { id: 2, user: "saki__study", text: "一緒に頑張ります📚", time: "0:31", color: "#7c3aed" },
  { id: 3, user: "takuya_run", text: "PUSH送ったよ💪", time: "0:45", color: "#0ea5e9" },
  { id: 4, user: "みさき", text: "ボム投げた！耐えて🔥", time: "1:02", color: "#ec4899" },
  { id: 5, user: "kento99", text: "配信みてるよ〜", time: "1:15", color: "#10b981" },
];

const mockTasks = [
  { id: 1, label: "腕立て50回", from: "takuya_run", reward: "¥500", cleared: false },
  { id: 2, label: "30分ノーストップ", from: "saki__study", reward: "¥200", cleared: true },
];

export default function PushStreamerUI() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [pushCount] = useState(7);
  const [viewers] = useState(12);
  const [comment, setComment] = useState("");
  const [tasks, setTasks] = useState(mockTasks);
  const timerRef = useRef(null);
  const startRef = useRef(null);

  // swipe to close drawer
  const dragStartY = useRef(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now() - elapsedTime * 1000;
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isLive]);

  const formatTime = (s) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  const openDrawer = (tabIndex) => {
    setActiveTab(tabIndex);
    setDrawerOpen(true);
  };

  const handleTouchStart = (e) => {
    dragStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    if (!dragStartY.current) return;
    const diff = e.changedTouches[0].clientY - dragStartY.current;
    if (diff > 60) setDrawerOpen(false);
    dragStartY.current = null;
  };

  const clearTask = (id) => {
    setTasks(t => t.map(task => task.id === id ? { ...task, cleared: true } : task));
  };

  const pendingTasks = tasks.filter(t => !t.cleared).length;

  return (
    <div style={{
      width: "100%",
      maxWidth: 390,
      height: "844px",
      margin: "0 auto",
      position: "relative",
      background: "#000",
      fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
      overflow: "hidden",
      borderRadius: 40,
      boxShadow: "0 0 80px rgba(0,0,0,0.8)",
    }}>

      {/* ── VIDEO BG ── */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(170deg, #0f0c1a 0%, #1a0f2e 40%, #0d1a2e 100%)" }}>
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "radial-gradient(ellipse at 30% 60%, rgba(120,60,200,0.15) 0%, transparent 60%), radial-gradient(ellipse at 70% 30%, rgba(255,107,53,0.08) 0%, transparent 50%)",
        }} />
        <div style={{
          position: "absolute", bottom: "28%", left: "50%", transform: "translateX(-50%)",
          width: 140, height: 240,
          borderRadius: "50% 50% 0 0",
          background: "radial-gradient(ellipse at center, rgba(255,200,150,0.12) 0%, transparent 70%)",
        }} />
        {/* subtle grid */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.03 }}>
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      {/* ── TOP HUD ── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        padding: "48px 16px 20px",
        background: "linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, transparent 100%)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isLive && (
            <div style={{
              background: "#ff3b30", borderRadius: 6, padding: "3px 9px",
              fontSize: 11, fontWeight: 800, color: "#fff", letterSpacing: 1.5,
              display: "flex", alignItems: "center", gap: 5,
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%", background: "#fff",
                animation: "blink 1.2s infinite",
              }} />
              LIVE
            </div>
          )}
          <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
            {formatTime(elapsedTime)}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>👁 {viewers}</span>
          <div style={{
            width: 30, height: 30, borderRadius: "50%",
            background: "rgba(255,255,255,0.12)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, cursor: "pointer",
          }}>✕</div>
        </div>
      </div>

      {/* ── RIGHT SIDE BUTTONS ── */}
      <div style={{
        position: "absolute",
        top: "50%", right: 14,
        transform: "translateY(-60%)",
        zIndex: 10,
        display: "flex", flexDirection: "column", gap: 14, alignItems: "center",
      }}>
        {[
          { icon: "💪", value: pushCount, label: "PUSH", tab: 2, accent: "rgba(255,255,255,0.12)", border: "rgba(255,255,255,0.2)", badge: false },
          { icon: "💣", value: pendingTasks, label: "試練", tab: 0, accent: "rgba(255,107,53,0.18)", border: "rgba(255,107,53,0.4)", badge: pendingTasks > 0 },
          { icon: "💬", value: mockComments.length, label: "コメント", tab: 1, accent: "rgba(255,255,255,0.12)", border: "rgba(255,255,255,0.2)", badge: false },
        ].map((btn) => (
          <button
            key={btn.label}
            onClick={() => openDrawer(btn.tab)}
            style={{
              background: btn.accent,
              backdropFilter: "blur(14px)",
              border: `1px solid ${btn.border}`,
              borderRadius: 18, padding: "10px 0",
              width: 54, display: "flex", flexDirection: "column",
              alignItems: "center", gap: 2, cursor: "pointer",
              position: "relative", outline: "none",
            }}>
            <span style={{ fontSize: 22 }}>{btn.icon}</span>
            <span style={{ color: btn.label === "試練" ? "#ff6b35" : "#fff", fontSize: 13, fontWeight: 700 }}>{btn.value}</span>
            <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 9, letterSpacing: 0.3 }}>{btn.label}</span>
            {btn.badge && (
              <div style={{
                position: "absolute", top: -3, right: -3,
                width: 10, height: 10, borderRadius: "50%",
                background: "#ff3b30",
                boxShadow: "0 0 6px rgba(255,59,48,0.8)",
              }} />
            )}
          </button>
        ))}
      </div>

      {/* ── FLOATING COMMENTS ── */}
      {!drawerOpen && (
        <div style={{
          position: "absolute",
          bottom: 140, left: 12, right: 80,
          zIndex: 10,
          display: "flex", flexDirection: "column", gap: 6,
          pointerEvents: "none",
        }}>
          {mockComments.slice(-3).map((c) => (
            <div key={c.id} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "rgba(0,0,0,0.4)",
              backdropFilter: "blur(10px)",
              borderRadius: 20, padding: "5px 10px",
              maxWidth: "fit-content",
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: "50%",
                background: c.color, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, color: "#fff", fontWeight: 700,
              }}>{c.user[0]}</div>
              <span style={{ color: c.color, fontSize: 12, fontWeight: 600 }}>{c.user}</span>
              <span style={{ color: "#fff", fontSize: 12 }}>{c.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── BOTTOM BAR ── */}
      <div style={{
        position: "absolute",
        bottom: 0, left: 0, right: 0,
        padding: "10px 14px 36px",
        background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%)",
        zIndex: 10,
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <button
          onClick={() => setIsLive(l => !l)}
          style={{
            background: isLive
              ? "rgba(255,59,48,0.85)"
              : "linear-gradient(135deg, #ff6b35 0%, #ff3b30 100%)",
            border: "none", borderRadius: 14, padding: "13px",
            color: "#fff", fontSize: 15, fontWeight: 800,
            cursor: "pointer", letterSpacing: 0.3,
            boxShadow: isLive ? "0 0 24px rgba(255,59,48,0.45)" : "0 4px 24px rgba(255,107,53,0.35)",
            transition: "all 0.25s",
            fontFamily: "inherit",
          }}>
          {isLive ? "⏹ 配信を終了する" : "🔴 配信を開始する"}
        </button>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{
            flex: 1,
            background: "rgba(255,255,255,0.1)",
            backdropFilter: "blur(10px)",
            borderRadius: 24,
            border: "1px solid rgba(255,255,255,0.14)",
            display: "flex", alignItems: "center", padding: "8px 14px",
          }}>
            <input
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="コメント..."
              style={{
                background: "transparent", border: "none", outline: "none",
                color: "#fff", fontSize: 14, width: "100%", fontFamily: "inherit",
              }}
            />
          </div>
          <button style={{
            background: "#ff6b35", border: "none", borderRadius: 20,
            padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700,
            cursor: "pointer", flexShrink: 0, fontFamily: "inherit",
          }}>送信</button>
        </div>
      </div>

      {/* ── DRAWER OVERLAY ── */}
      <div
        onClick={() => setDrawerOpen(false)}
        style={{
          position: "absolute", inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 19,
          opacity: drawerOpen ? 1 : 0,
          pointerEvents: drawerOpen ? "all" : "none",
          transition: "opacity 0.3s",
        }}
      />

      {/* ── DRAWER ── */}
      <div
        ref={drawerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          position: "absolute",
          left: 0, right: 0,
          bottom: drawerOpen ? 0 : "-72%",
          height: "72%",
          background: "rgba(8,4,18,0.97)",
          backdropFilter: "blur(24px)",
          borderRadius: "24px 24px 0 0",
          zIndex: 20,
          transition: "bottom 0.38s cubic-bezier(0.32, 0.72, 0, 1)",
          display: "flex", flexDirection: "column",
          border: "1px solid rgba(255,255,255,0.09)",
          borderBottom: "none",
        }}>

        {/* handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 6px" }}>
          <div style={{ width: 38, height: 4, background: "rgba(255,255,255,0.22)", borderRadius: 2 }} />
        </div>

        {/* tabs */}
        <div style={{
          display: "flex",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          padding: "0 16px",
        }}>
          {TABS.map((tab, i) => (
            <button key={tab} onClick={() => setActiveTab(i)} style={{
              flex: 1, padding: "10px 0",
              background: "transparent", border: "none",
              borderBottom: activeTab === i ? "2px solid #ff6b35" : "2px solid transparent",
              color: activeTab === i ? "#ff6b35" : "rgba(255,255,255,0.35)",
              fontSize: 13, fontWeight: activeTab === i ? 700 : 400,
              cursor: "pointer", transition: "all 0.2s", fontFamily: "inherit",
            }}>{tab}</button>
          ))}
        </div>

        {/* content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 24px" }}>

          {/* タスク */}
          {activeTab === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, margin: "0 0 4px", letterSpacing: 1, textTransform: "uppercase" }}>
                💣 ボムタスク
              </p>
              {tasks.map(task => (
                <div key={task.id} style={{
                  background: task.cleared ? "rgba(255,255,255,0.03)" : "rgba(255,107,53,0.09)",
                  border: `1px solid ${task.cleared ? "rgba(255,255,255,0.07)" : "rgba(255,107,53,0.28)"}`,
                  borderRadius: 14, padding: "12px 14px",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{
                      color: task.cleared ? "rgba(255,255,255,0.3)" : "#fff",
                      fontSize: 14, fontWeight: 600,
                      textDecoration: task.cleared ? "line-through" : "none",
                    }}>{task.label}</div>
                    <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, marginTop: 2 }}>
                      from {task.from}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                    <div style={{ color: "#ff6b35", fontSize: 13, fontWeight: 700 }}>{task.reward}</div>
                    {task.cleared ? (
                      <span style={{ color: "#10b981", fontSize: 11 }}>✓ クリア済</span>
                    ) : (
                      <button
                        onClick={() => clearTask(task.id)}
                        style={{
                          background: "#ff6b35", border: "none", borderRadius: 8,
                          padding: "4px 10px", color: "#fff", fontSize: 11, fontWeight: 700,
                          cursor: "pointer", fontFamily: "inherit",
                        }}>
                        クリア
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* コメント */}
          {activeTab === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {mockComments.map(c => (
                <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: "50%",
                    background: c.color, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, color: "#fff",
                  }}>{c.user[0]}</div>
                  <div style={{ flex: 1 }}>
                    <div>
                      <span style={{ color: c.color, fontSize: 13, fontWeight: 700 }}>{c.user} </span>
                      <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>{c.time}</span>
                    </div>
                    <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, marginTop: 2 }}>{c.text}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* インサイト */}
          {activeTab === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "ギフト合計", value: "¥1,200", icon: "🎁", color: "#ff6b35" },
                { label: "視聴者数", value: viewers, icon: "👁", color: "#0ea5e9" },
                { label: "PUSH数", value: pushCount, icon: "💪", color: "#7c3aed" },
                { label: "試練クリア", value: `${tasks.filter(t=>t.cleared).length} / ${tasks.length}`, icon: "💣", color: "#10b981" },
                { label: "ブースト", value: "×1.0", icon: "⚡", color: "#f59e0b" },
                { label: "配信時間", value: formatTime(elapsedTime), icon: "⏱", color: "#ec4899" },
              ].map(stat => (
                <div key={stat.label} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 12, padding: "11px 14px",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 18 }}>{stat.icon}</span>
                    <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 13 }}>{stat.label}</span>
                  </div>
                  <span style={{ color: stat.color, fontSize: 16, fontWeight: 700 }}>{stat.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
        *{box-sizing:border-box}
        ::-webkit-scrollbar{display:none}
      `}</style>
    </div>
  );
}
