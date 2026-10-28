import { useState } from "react";
import { createApi } from "./api.js";
import type { Connection } from "./session.js";

/**
 * Collects the service address and the bearer token published by the service
 * via stdout (token file path). The token is only kept in memory and then
 * sessionStorage; it is displayed masked and never logged.
 */
export function ConnectForm({
  onConnect,
}: {
  onConnect: (connection: Connection) => void;
}) {
  const [base, setBase] = useState("http://127.0.0.1:51717");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = base.trim().replace(/\/+$/, "");
    if (!normalized || !token.trim()) {
      setError("Service address and token are both required.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      // A successful list call validates the address and token together.
      await createApi(normalized, token.trim()).listRuns();
      onConnect({ base: normalized, token: token.trim() });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Connection failed; inspect address and token.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="connect-form" onSubmit={(event) => void submit(event)}>
      <h1>Loom Workbench</h1>
      <p>
        Start the service with{" "}
        <code>npm run service -- --data-root DIR --http</code> and paste the
        published address and bearer token (read the token from the printed
        token file path).
      </p>
      <label>
        Service address
        <input
          name="base"
          value={base}
          onChange={(event) => setBase(event.target.value)}
          placeholder="http://127.0.0.1:54321"
        />
      </label>
      <label>
        Bearer token
        <input
          name="token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="contents of the http-token file"
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Connect"}
      </button>
      {error ? (
        <p role="alert" data-testid="connect-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
