import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

export function AuthLayout({ children }: { children: ComponentChildren }) {
  return (
    <main className="zyAuth">
      <header className="zyAuth-brand">
        <span className="zyAuth-mark">ZY</span>
        <div>
          <strong>ZY 财务工作台</strong>
          <span>代账团队协作平台</span>
        </div>
      </header>
      <div className="zyAuth-layout">
        <section className="zyAuth-story" aria-label="工作台介绍">
          <span className="zyAuth-kicker">FINANCE, IN ORDER.</span>
          <h1>
            让每一份交付，
            <br />
            都有条不紊。
          </h1>
          <p>
            从资料收集到月度归档，
            <br />
            把客户、任务和团队协作放在同一个工作台。
          </p>
          <div className="zyAuth-flow" aria-label="月度交付流程">
            <div className="zyAuth-flowTitle">
              <span>月度交付流程</span>
              <span>全程留痕</span>
            </div>
            {[
              ["01", "资料归集", "按客户与期间整理原始资料"],
              ["02", "经办处理", "工作流衔接，任务责任明确"],
              ["03", "独立复核", "核对成果版本，记录审核意见"],
              ["04", "交付归档", "保留交付证据与完整历史"],
            ].map(([n, title, note]) => (
              <div className="zyAuth-step" key={n}>
                <span>{n}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{note}</small>
                </div>
              </div>
            ))}
          </div>
          <div className="zyAuth-principles">
            <span>客户资料隔离</span>
            <i /> <span>团队权限协作</span>
            <i /> <span>成果版本可追溯</span>
          </div>
        </section>
        <section className="zyAuth-entry" aria-label="账号访问">
          {children}
        </section>
      </div>
      <footer className="zyAuth-footer">
        ZY FINANCE WORKBENCH <span>专注财务，让协作更清楚。</span>
      </footer>
    </main>
  );
}

export function AuthPassword({
  label = "密码",
  name = "password",
  fresh = false,
}: {
  label?: string;
  name?: string;
  fresh?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="zyAuth-field">
      <label htmlFor={"auth-" + name}>{label}</label>
      <div className="zyAuth-password">
        <input
          id={"auth-" + name}
          name={name}
          required
          minLength={fresh ? 12 : undefined}
          {...(visible
            ? { type: "text" as const }
            : { type: "password" as const })}
          autoComplete={fresh ? "new-password" : "current-password"}
          placeholder={fresh ? "至少 12 位字符" : "请输入密码"}
        />
        <button
          type="button"
          aria-label={visible ? "隐藏密码" : "显示密码"}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {visible && <path d="m3 3 18 18" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
