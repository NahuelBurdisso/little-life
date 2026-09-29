import { useCallback, useRef } from "react";

interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  className?: string;
}

export function ResizeHandle({ direction, onResize, className }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;

      const handleMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const current = direction === "horizontal" ? e.clientX : e.clientY;
        const delta = current - lastPos.current;
        lastPos.current = current;
        onResize(delta);
      };

      const handleMouseUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [direction, onResize],
  );

  const isHorizontal = direction === "horizontal";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`${isHorizontal ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"} bg-ui-raised hover:bg-ui-blue active:bg-ui-blue transition-colors flex-shrink-0 z-10 ${className ?? ""}`}
    />
  );
}
