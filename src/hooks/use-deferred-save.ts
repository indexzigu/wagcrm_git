"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseDeferredSaveOptions = {
  /** Async save handler — receives accumulated patch object */
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  /** Idle timeout in ms before auto-save triggers (default: 5000) */
  idleTimeout?: number;
  /** Whether to automatically save on idle timeout or unmount (default: true) */
  autoSave?: boolean;
};

type UseDeferredSaveReturn = {
  /** Accumulated pending changes (field → value) */
  pendingChanges: Record<string, unknown>;
  /** Whether there are unsaved changes */
  hasPendingChanges: boolean;
  /** Whether a save is currently in progress */
  isSaving: boolean;
  /** Queue a field change (does NOT trigger immediate save) */
  updateField: (field: string, value: unknown) => void;
  /** Immediately save all pending changes */
  saveNow: () => Promise<void>;
  /** Discard all pending changes without saving */
  resetChanges: () => void;
};

/**
 * Hook that accumulates field changes and saves them either:
 * 1. When the user clicks "저장하기" (saveNow)
 * 2. After `idleTimeout` ms of no new changes (auto-save)
 * 3. On unmount if there are pending changes
 */
export function useDeferredSave({
  onSave,
  idleTimeout = 5000,
  autoSave = true,
}: UseDeferredSaveOptions): UseDeferredSaveReturn {
  const [pendingChanges, setPendingChanges] = useState<Record<string, unknown>>({});
  const [isSaving, setIsSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Record<string, unknown>>({});
  const onSaveRef = useRef(onSave);

  // Keep onSave ref current to avoid stale closures
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Keep pendingRef in sync with state
  useEffect(() => {
    pendingRef.current = pendingChanges;
  }, [pendingChanges]);

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  const doSave = useCallback(async () => {
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;

    setIsSaving(true);
    try {
      await onSaveRef.current(patch);
      setPendingChanges({});
      pendingRef.current = {};
    } catch {
      // Keep pending changes on failure — user can retry
    } finally {
      setIsSaving(false);
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    if (!autoSave) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      void doSave();
    }, idleTimeout);
  }, [doSave, idleTimeout, autoSave]);

  const updateField = useCallback(
    (field: string, value: unknown) => {
      setPendingChanges((prev) => ({ ...prev, [field]: value }));
      pendingRef.current = { ...pendingRef.current, [field]: value };
      resetIdleTimer();
    },
    [resetIdleTimer],
  );

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  const resetChanges = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPendingChanges({});
    pendingRef.current = {};
  }, []);

  // Auto-save on unmount if there are pending changes and autoSave is true
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (autoSave && Object.keys(pendingRef.current).length > 0) {
        void onSaveRef.current(pendingRef.current);
      }
    };
  }, [autoSave]);

  return {
    pendingChanges,
    hasPendingChanges,
    isSaving,
    updateField,
    saveNow,
    resetChanges,
  };
}
