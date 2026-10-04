import type { ListenClient } from "./types.ts";

/**
 * Listen for PostgREST-style schema reload notifications and invoke `onReload`.
 *
 * PostgREST reloads its schema cache on `NOTIFY pgrst, 'reload schema'`. A
 * LISTEN requires a dedicated, long-lived connection (it cannot share a pooled
 * client), so the caller supplies one. Returns a `stop()` that ends the client.
 */
export interface NotifyListenerOptions {
  channel?: string;
  /** Payload that triggers a reload. Defaults to `reload schema` (PostgREST). */
  reloadMessage?: string;
  onReload: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface NotifyListener {
  stop(): Promise<void>;
}

export async function startSchemaListener(
  client: ListenClient,
  options: NotifyListenerOptions,
): Promise<NotifyListener> {
  const channel = options.channel ?? "pgrst";
  const reloadMessage = options.reloadMessage ?? "reload schema";

  const handler = (message: { channel: string; payload?: string }) => {
    if (message.channel !== channel) return;
    if (message.payload && message.payload !== reloadMessage) return;
    Promise.resolve(options.onReload()).catch((error) => options.onError?.(error));
  };

  await client.query(`listen ${quoteIdentifier(channel)}`);
  client.on("notification", handler);
  client.on("error", (error) => options.onError?.(error));

  return {
    async stop() {
      client.removeListener("notification", handler);
      try {
        await client.query(`unlisten ${quoteIdentifier(channel)}`);
      } finally {
        await client.end();
      }
    },
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
