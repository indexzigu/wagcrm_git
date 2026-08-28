"use client";

import { AlertCircle, Link2, Link2Off, RefreshCw, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import {
  EntityIdentity,
  type EntityIdentityPart,
} from "@/components/crm/entity-identity";

// --- Types ---

export type LinkedEntityItem = {
  id: string;
  primaryLabel: string;
  secondaryLabels: string[];
  inlineLabel?: string;
  identityParts?: EntityIdentityPart[];
  customNode?: React.ReactNode;
  status?: string;
  statusNode?: React.ReactNode;
  date?: string;
};

export type LinkedEntitySectionProps = {
  title?: string;
  entities: LinkedEntityItem[];
  loading: boolean;
  error?: string;
  emptyMessage: string;
  onLinkClick?: () => void;
  onUnlinkClick?: (entityId: string) => void;
  onEntityClick: (entityId: string) => void;
  onRetry?: () => void;
  linkButtonLabel?: string;
  /** FK가 필수인 경우 연결 해제 대신 연결 변경 제공 */
  isRequiredLink?: boolean;
  onChangeLinkClick?: (entityId: string) => void;
};

// --- Loading Skeleton ---

function EntityListSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-5 w-14" />
        </div>
      ))}
    </div>
  );
}

// --- Error State ---

function ErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="size-4" />
        <span>{error}</span>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3.5" />
          재시도
        </Button>
      )}
    </div>
  );
}

// --- Empty State ---

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border/70 p-6">
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

// --- Entity Item ---

function EntityItem({
  entity,
  isRequiredLink,
  onEntityClick,
  onUnlinkClick,
  onChangeLinkClick,
}: {
  entity: LinkedEntityItem;
  isRequiredLink?: boolean;
  onEntityClick: (entityId: string) => void;
  onUnlinkClick?: (entityId: string) => void;
  onChangeLinkClick?: (entityId: string) => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border hover:bg-muted/30">
      {/* Clickable content area */}
      <button
        type="button"
        className="flex flex-1 items-center gap-3 text-left min-w-0"
        onClick={() => onEntityClick(entity.id)}
      >
        <div className="min-w-0 flex-1">
          {entity.customNode ? (
            entity.customNode
          ) : entity.identityParts ? (
            <EntityIdentity parts={entity.identityParts} className="max-w-full" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] min-w-0 truncate">
              <p className="truncate font-medium text-foreground">
                {entity.primaryLabel}
              </p>
              {entity.inlineLabel ? (
                <span className="truncate text-muted-foreground">{entity.inlineLabel}</span>
              ) : null}
            </div>
          )}
          {!entity.customNode && entity.secondaryLabels.length > 0 && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {entity.secondaryLabels.join(" · ")}
            </p>
          )}
        </div>
        {(entity.status || entity.statusNode || entity.date) && (
          <div className="flex w-[120px] shrink-0 flex-row items-center justify-end gap-1.5 text-right">
            {entity.statusNode ? (
              entity.statusNode
            ) : entity.status ? (
              <Badge variant="secondary" className="max-w-[80px] truncate text-[9px] px-1 h-4">
                {entity.status}
              </Badge>
            ) : null}
            {entity.date && (
              <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                {formatDate(entity.date)}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Action button */}
      <div className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 flex items-center justify-center">
        {isRequiredLink ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onChangeLinkClick?.(entity.id);
            }}
            title="연결 변경"
          >
            <Repeat className="size-2.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onUnlinkClick?.(entity.id);
            }}
            title="연결 해제"
          >
            <Link2Off className="size-2.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Main Component ---

export function LinkedEntitySection({
  title,
  entities,
  loading,
  error,
  emptyMessage,
  onLinkClick,
  onUnlinkClick,
  onEntityClick,
  onRetry,
  linkButtonLabel,
  isRequiredLink,
  onChangeLinkClick,
}: LinkedEntitySectionProps) {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {onLinkClick && (
          <Button
            variant="outline"
            onClick={onLinkClick}
            className="h-5.5 text-[10px] px-2 py-0 gap-0.5 rounded-md border-slate-200 text-slate-600 inline-flex items-center"
          >
            <Link2 className="size-2.5" />
            <span>{linkButtonLabel ?? "연결"}</span>
          </Button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <EntityListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : entities.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <div className="space-y-2">
          {entities.map((entity) => (
            <EntityItem
              key={entity.id}
              entity={entity}
              isRequiredLink={isRequiredLink}
              onEntityClick={onEntityClick}
              onUnlinkClick={onUnlinkClick}
              onChangeLinkClick={onChangeLinkClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
