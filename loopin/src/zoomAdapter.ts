import zoomSdk from "@zoom/appssdk";
import type { Command, View } from "../shared/types";
export type ZoomConnection = {
  send: (c: Command) => Promise<void>;
  dispose: () => void;
  expand: () => void;
  popout: () => void;
  closePanel: () => void;
  startListening: () => void;
};
export async function connectZoom(
  onState: (v: View) => void,
  onConnection: (v: boolean) => void,
  onError: (s: string) => void,
): Promise<ZoomConnection> {
  const capabilities = [
    "getAppContext",
    "getMeetingParticipants",
    "getUserContext",
    "onParticipantChange",
    "onMyUserContextChange",
    "onParticipantEmail",
    "getMeetingParticipantsEmail",
    "showNotification",
    "expandApp",
    "appPopout",
    "closeApp",
    "startRTMS",
    "getRTMSStatus",
    "onRTMSStatusChange",
  ] as const;
  await zoomSdk.config({ capabilities: [...capabilities], version: "0.16.0" });
  let disposed = false,
    ws: WebSocket | undefined,
    reconnect: ReturnType<typeof setTimeout> | undefined,
    lastPrompt = "",
    role = "attendee";
  const emails = new Map<string, string>();
  const context = async () => (await zoomSdk.getAppContext()).context;
  const request = async (path: string, body?: unknown) => {
    const res = await fetch("/loopin/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-zoom-app-context": await context(),
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || "Meeting request failed");
    return data;
  };
  const syncRoster = async () => {
    if (disposed || role !== "organizer") return;
    try {
      const result = await zoomSdk.getMeetingParticipants();
      await request("/roster", {
        participants: result.participants.map((p) => ({
          id: p.participantUUID || String(p.participantId),
          name: p.screenName,
          ...(emails.has(p.participantUUID)
            ? { email: emails.get(p.participantUUID) }
            : {}),
        })),
      });
    } catch (e) {
      onError(`Roster: ${(e as Error).message}`);
    }
  };
  const accept = (v: View) => {
    role = v.role;
    onState(v);
    if (
      v.role === "attendee" &&
      v.prompt &&
      !v.prompt.answered &&
      v.prompt.pollId !== lastPrompt
    ) {
      lastPrompt = v.prompt.pollId;
      void zoomSdk
        .showNotification({
          type: "info",
          title: "LoopIn wants your input",
          message: v.prompt.question,
        } as unknown as Parameters<typeof zoomSdk.showNotification>[0])
        .catch(() =>
          onError(
            "The prompt is ready here; Zoom notifications are unavailable.",
          ),
        );
    }
  };
  const initial = await request("/state");
  accept(initial);
  await syncRoster();
  const open = () => {
    if (disposed) return;
    ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/loopin/ws`,
    );
    ws.onopen = () => {
      void context()
        .then((value) => {
          if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "auth", context: value }));
        })
        .catch((e) => onError(e.message));
    };
    ws.onmessage = (e) => {
      try {
        const value = JSON.parse(e.data);
        if (value.error) {
          onError(value.error);
          return;
        }
        accept(value);
        onConnection(true);
      } catch {
        onError("Invalid meeting update");
      }
    };
    ws.onclose = () => {
      onConnection(false);
      if (!disposed) reconnect = setTimeout(open, 2000);
    };
  };
  open();
  const renew = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN)
      void context()
        .then((value) => {
          if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "auth", context: value }));
        })
        .catch((e) => onError(e.message));
    void syncRoster();
  }, 10000);
  zoomSdk.onParticipantChange(() => void syncRoster());
  zoomSdk.onParticipantEmail((e) => {
    if (e.participantEmail) emails.set(e.participantUUID, e.participantEmail);
    void syncRoster();
  });
  zoomSdk.onMyUserContextChange(() => {
    if (disposed) return;
    onConnection(false);
    void request("/state")
      .then((v) => {
        accept(v);
        onConnection(true);
        return syncRoster();
      })
      .catch((e) => onError(e.message));
  });
  // Consent is explicit via Zoom's own UI. A refusal retains unique-name matching.
  if (role === "organizer")
    void zoomSdk.getMeetingParticipantsEmail().catch(() => {});
  return {
    send: async (c) => {
      await request("/command", c);
    },
    dispose: () => {
      disposed = true;
      clearInterval(renew);
      clearTimeout(reconnect);
      ws?.close();
    },
    expand: () => {
      void zoomSdk
        .expandApp({ action: "expand" })
        .catch((e) => onError(e.message));
    },
    popout: () => {
      void zoomSdk
        .appPopout({ action: "undock" })
        .catch((e) => onError(e.message));
    },
    closePanel: () => {
      void zoomSdk.closeApp().catch((e) => onError(e.message));
    },
    startListening: () => {
      void zoomSdk.startRTMS().catch((e) => onError("RTMS: " + e.message));
    },
  };
}
