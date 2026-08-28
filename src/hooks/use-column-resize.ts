"use client";

import { useState, useCallback, useRef, useEffect } from "react";

export type ColumnWidths = Record<string, number>;

function getStorageKey(id?: string): string | null {
  return id ? `wag-crm:col-widths:${id}` : null;
}

function loadWidths(storageKey: string | null, fallback: ColumnWidths): ColumnWidths {
  if (!storageKey || typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnWidths;
      // Merge: use stored values where available, fallback for new columns
      return { ...fallback, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return fallback;
}

export function useColumnResize(initialWidths: ColumnWidths, persistId?: string) {
  const storageKey = getStorageKey(persistId);
  const [widths, setWidths] = useState<ColumnWidths>(initialWidths);

  // Load persisted widths after mount to avoid hydration mismatch
  useEffect(() => {
    if (storageKey) {
      const loaded = loadWidths(storageKey, initialWidths);
      setWidths(loaded);
    }
  }, [storageKey, initialWidths]);

  const resizingColumn = useRef<string | null>(null);
  const startX = useRef<number>(0);
  const startWidth = useRef<number>(0);

  // Persist to localStorage on change (debounced via mouseup)
  const saveRef = useRef(widths);
  useEffect(() => {
    saveRef.current = widths;
  }, [widths]);

  const onMouseDown = useCallback((columnId: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizingColumn.current = columnId;
    startX.current = event.pageX;
    startWidth.current = widths[columnId] || 150;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingColumn.current) return;
      
      const delta = moveEvent.pageX - startX.current;
      const newWidth = Math.max(60, startWidth.current + delta);
      
      setWidths((prev) => ({
        ...prev,
        [resizingColumn.current!]: newWidth,
      }));
    };

    const onMouseUp = () => {
      resizingColumn.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      // Save to localStorage after resize completes
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(saveRef.current));
        } catch {
          // Ignore quota errors
        }
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
  }, [widths, storageKey]);

  return {
    widths,
    onMouseDown,
  };
}
