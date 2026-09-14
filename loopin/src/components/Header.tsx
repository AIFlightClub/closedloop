import type { ZoomConnection } from "../zoomAdapter";
import { mark } from "../ui";
export default function Header({ controls }: { controls?: ZoomConnection }) {
  return (
    <header className="panel-header">
      <span className="brand">
        {mark}
        <b>LoopIn</b>
      </span>
      <span className="window-actions">
        {controls && (
          <>
            <button title="Expand panel" onClick={() => controls.expand()}>
              ⤢
            </button>
            <button title="Pop out panel" onClick={() => controls.popout()}>
              ⧉
            </button>
            <button title="Close panel" onClick={() => controls.closePanel()}>
              ×
            </button>
          </>
        )}
      </span>
    </header>
  );
}
