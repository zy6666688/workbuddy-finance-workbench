import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

// These are the two configured local entry points, not an authentication check.
// Unknown hosts/ports must not silently inherit a production label.
export function loginEnvironment(location = window.location) {
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    location.hostname,
  );
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const kind =
    local && port === "8096"
      ? "production"
      : local && port === "8081"
        ? "test"
        : "unknown";
  return {
    kind,
    port,
    address: location.origin,
    title:
      kind === "production"
        ? "正式工作台"
        : kind === "test"
          ? "测试环境"
          : "环境待确认",
    purpose:
      kind === "production"
        ? "用于日常客户业务、资料管理、人工复核与正式交付。"
        : kind === "test"
          ? "仅用于虚构样本和功能验证，不用于正式客户业务。"
          : "当前地址不在已标记的本机入口中，请先向负责人确认用途。",
    accountNote:
      kind === "test"
        ? "测试环境使用独立数据库和账号密码。正式账号的密码在这里可能无法登录；日常工作请前往 8096 正式工作台。"
        : kind === "production"
          ? "请使用正式团队账号。8081 测试环境的账号、密码与资料独立。"
          : "确认环境后再使用对应账号，不能仅凭页面外观判断是正式工作台。",
    officialUrl:
      local && kind !== "production" ? "http://localhost:8096/" : null,
    loginLabel:
      kind === "production"
        ? "登录正式工作台"
        : kind === "test"
          ? "登录测试环境"
          : "登录当前工作台",
  };
}

export function AuthLayout({ children }: { children: ComponentChildren }) {
  const environment = loginEnvironment();
  useEffect(() => {
    document.title = `${environment.title} · ${environment.port} | ZY 财务工作台`;
  }, [environment.title, environment.port]);
  return (
    <main className="zyAuth" data-environment={environment.kind}>
      <header className="zyAuth-brand">
        <span className="zyAuth-mark">ZY</span>
        <div>
          <strong>ZY 财务工作台</strong>
          <span>代账团队协作平台</span>
        </div>
      </header>
      <section className="zyAuth-environment" aria-label="当前工作台环境">
        <div className="zyAuth-environmentHeading">
          <strong>{environment.title}</strong>
          <span>端口 {environment.port}</span>
        </div>
        <p>{environment.purpose}</p>
        <p>{environment.accountNote}</p>
        <p className="zyAuth-environmentAddress">
          当前地址：{environment.address}
        </p>
        {environment.officialUrl && (
          <a className="zyAuth-officialLink" href={environment.officialUrl}>
            前往正式工作台 · 8096
          </a>
        )}
      </section>
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
