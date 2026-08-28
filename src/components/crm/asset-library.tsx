"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useFilterParams } from "@/hooks/use-filter-params";
import {
  Archive,
  ExternalLink,
  FileText,
  FolderOpen,
  HardDrive,
  Link as LinkIcon,
  RefreshCcw,
  Search,
  ChevronDown,
  ChevronRight,
  Folder,
  LayoutGrid,
  List,
  FolderTree,
  File,
  FileArchive,
  FileSpreadsheet,
  Video,
  Image as ImageIcon,
  Pencil,
  ArchiveRestore
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CrmShell } from "./crm-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  assetProviderLabels,
  assetSectionLabels,
  type AssetEntityType,
  type AssetRow,
  type AssetSection,
  type DashboardData,
} from "@/lib/crm-types";
import { formatBytes } from "@/lib/format";
import { DataSourceBanner } from "./data-source-banner";

const sectionValues = Object.keys(assetSectionLabels) as AssetSection[];

type EntityOption = {
  type: AssetEntityType;
  id: string;
  name: string;
};

interface TreeNode {
  id: string;
  name: string;
  type: "folder" | "file";
  folderType?: "PARTNER" | "DEAL" | "CAMPAIGN" | "OUTREACH" | "SELLER" | "SECTION" | "ROOT" | "OTHERS";
  section?: AssetSection;
  entityType?: AssetEntityType;
  entityId?: string;
  asset?: AssetRow;
  children: TreeNode[];
}

interface FlatNode {
  id: string;
  name: string;
  type: "folder" | "file";
  folderType?: "PARTNER" | "DEAL" | "CAMPAIGN" | "OUTREACH" | "SELLER" | "SECTION" | "ROOT" | "OTHERS";
  section?: AssetSection;
  entityType?: AssetEntityType;
  entityId?: string;
  asset?: AssetRow;
  depth: number;
  isOpen?: boolean;
  hasChildren: boolean;
}

function getFileIcon(mimeType: string | null | undefined, fileName: string) {
  const mime = mimeType?.toLowerCase() || "";
  const ext = fileName.split('.').pop()?.toLowerCase() || "";
  
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    return <ImageIcon className="size-4 text-emerald-500 shrink-0" />;
  }
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv"].includes(ext)) {
    return <Video className="size-4 text-rose-500 shrink-0" />;
  }
  if (
    mime.includes("spreadsheet") || 
    mime.includes("excel") || 
    mime.includes("sheet") || 
    ["xlsx", "xls", "csv"].includes(ext)
  ) {
    return <FileSpreadsheet className="size-4 text-teal-600 shrink-0" />;
  }
  if (
    mime.includes("zip") || 
    mime.includes("archive") || 
    mime.includes("compressed") || 
    ["zip", "tar", "gz", "rar", "7z"].includes(ext)
  ) {
    return <FileArchive className="size-4 text-amber-600 shrink-0" />;
  }
  if (
    mime.includes("pdf") || 
    mime.includes("word") || 
    mime.includes("presentation") || 
    mime.includes("powerpoint") ||
    ["pdf", "docx", "doc", "pptx", "ppt", "txt", "hwp"].includes(ext)
  ) {
    return <FileText className="size-4 text-blue-500 shrink-0" />;
  }
  return <File className="size-4 text-slate-400 shrink-0" />;
}

function getAssetOriginInfo(
  asset: AssetRow,
  entityNameByKey: Map<string, string>,
  entityPartnerMap: Map<string, { partnerId: string; partnerName: string }>
) {
  const partnerInfo = entityPartnerMap.get(`${asset.entityType}:${asset.entityId}`);
  const entityName = entityNameByKey.get(`${asset.entityType}:${asset.entityId}`) ?? asset.entityId;

  let badgeText = "";
  let primaryName = ""; 
  let secondaryName = ""; 

  switch (asset.entityType) {
    case "PARTNER":
      badgeText = "거래처";
      primaryName = entityName;
      break;
    case "DEAL":
      badgeText = "딜";
      primaryName = partnerInfo?.partnerName ?? "미지정 거래처";
      secondaryName = entityName;
      break;
    case "CAMPAIGN":
      badgeText = "캠페인";
      primaryName = partnerInfo?.partnerName ?? "미지정 거래처";
      secondaryName = entityName;
      break;
    case "OUTREACH":
      badgeText = "영업";
      primaryName = partnerInfo?.partnerName ?? "미지정 거래처";
      secondaryName = entityName;
      break;
    case "SELLER":
      badgeText = "셀러";
      primaryName = entityName;
      break;
    default:
      badgeText = "자료";
      primaryName = entityName;
  }

  return { badgeText, primaryName, secondaryName };
}

export function AssetLibrary({
  initialData,
  driveStatus,
}: {
  initialData: DashboardData;
  driveStatus?: "connected" | "error" | null;
}) {
  const [assets, setAssets] = useState(initialData.assets);
  const [viewMode, setViewMode] = useState<"gallery" | "list" | "tree">("gallery");
  const [galleryCols, setGalleryCols] = useState<3 | 4>(3);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const savedMode = localStorage.getItem("wag-crm-assets-view-mode");
      if (savedMode && ["gallery", "list", "tree"].includes(savedMode)) {
        setViewMode(savedMode as any);
      }
      const savedCols = localStorage.getItem("wag-crm-assets-gallery-cols");
      if (savedCols && (savedCols === "3" || savedCols === "4")) {
        setGalleryCols(parseInt(savedCols, 10) as 3 | 4);
      }
    }
  }, []);

  const changeViewMode = (mode: "gallery" | "list" | "tree") => {
    setViewMode(mode);
    if (typeof window !== "undefined") {
      localStorage.setItem("wag-crm-assets-view-mode", mode);
    }
  };

  const changeGalleryCols = (cols: 3 | 4) => {
    setGalleryCols(cols);
    if (typeof window !== "undefined") {
      localStorage.setItem("wag-crm-assets-gallery-cols", cols.toString());
    }
  };

  const { filters, setFilter } = useFilterParams();
  const query = filters.q || "";
  const sectionFilter = (filters.sectionFilter as AssetSection | "ALL") || "ALL";
  const entityTypeFilter = (filters.entityTypeFilter as AssetEntityType | "ALL") || "ALL";

  const [localQuery, setLocalQuery] = useState(query);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const debouncedSetFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (!isComposingRef.current) {
          setFilter("q", value);
        }
      }, 350);
    },
    [setFilter]
  );

  const [busy, setBusy] = useState(false);

  const entityOptions = useMemo<EntityOption[]>(
    () => [
      ...initialData.campaigns.map((campaign) => ({
        type: "CAMPAIGN" as const,
        id: campaign.id,
        name: campaign.dealName,
      })),
      ...initialData.deals.map((deal) => ({
        type: "DEAL" as const,
        id: deal.id,
        name: deal.dealName,
      })),
      ...(initialData.partners ?? []).map((partner) => ({
        type: "PARTNER" as const,
        id: partner.id,
        name: partner.name,
      })),
      ...initialData.sellers.map((seller) => ({
        type: "SELLER" as const,
        id: seller.id,
        name: seller.name,
      })),
      ...(initialData.salesTasks ?? []).map((task) => ({
        type: "OUTREACH" as const,
        id: task.id,
        name: `${task.dealName} - ${task.sellerName}`,
      })),
    ],
    [initialData],
  );
 
  const entityNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    entityOptions.forEach((option) => map.set(`${option.type}:${option.id}`, option.name));
    return map;
  }, [entityOptions]);
 
  const entityPartnerMap = useMemo(() => {
    const map = new Map<string, { partnerId: string; partnerName: string }>();
 
    // 1. 거래처 직접 매핑 (PARTNER)
    const partnersList = new Map<string, string>();
    if (initialData.partners) {
      initialData.partners.forEach((partner) => {
        partnersList.set(partner.id, partner.name);
      });
    } else {
      initialData.deals.forEach((deal) => {
        if (deal.partner) {
          partnersList.set(deal.partner.id, deal.partner.name);
        }
      });
    }
    partnersList.forEach((name, id) => {
      map.set(`PARTNER:${id}`, { partnerId: id, partnerName: name });
    });
 
    // 2. 딜을 통한 거래처 매핑 (DEAL)
    initialData.deals.forEach((deal) => {
      if (deal.partner) {
        map.set(`DEAL:${deal.id}`, { partnerId: deal.partner.id, partnerName: deal.partner.name });
      }
    });
 
    // 3. 캠페인을 통한 거래처 매핑 (CAMPAIGN)
    initialData.campaigns.forEach((campaign) => {
      const deal = initialData.deals.find((d) => d.id === campaign.dealId);
      if (deal && deal.partner) {
        map.set(`CAMPAIGN:${campaign.id}`, { partnerId: deal.partner.id, partnerName: deal.partner.name });
      } else if (campaign.partnerName) {
        map.set(`CAMPAIGN:${campaign.id}`, { partnerId: "", partnerName: campaign.partnerName });
      }
    });
 
    // 4. 영업 태스크를 통한 거래처 매핑 (OUTREACH)
    if (initialData.salesTasks) {
      initialData.salesTasks.forEach((task) => {
        if (task.dealId) {
          const deal = initialData.deals.find((d) => d.id === task.dealId);
          if (deal && deal.partner) {
            map.set(`OUTREACH:${task.id}`, { partnerId: deal.partner.id, partnerName: deal.partner.name });
          }
        }
      });
    }
 
    // 5. 셀러 (SELLER)
    initialData.sellers.forEach((seller) => {
      map.set(`SELLER:${seller.id}`, { partnerId: seller.id, partnerName: seller.name });
    });
 
    return map;
  }, [initialData]);

  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const entityName = entityNameByKey.get(`${asset.entityType}:${asset.entityId}`) ?? "";
      const matchesQuery =
        !normalized ||
        asset.fileName.toLowerCase().includes(normalized) ||
        (asset.notes ?? "").toLowerCase().includes(normalized) ||
        entityName.toLowerCase().includes(normalized);
      const matchesSection = sectionFilter === "ALL" || asset.section === sectionFilter;
      const matchesEntityType = entityTypeFilter === "ALL" || asset.entityType === entityTypeFilter;
      
      const matchesArchive = showArchived ? !!asset.archivedAt : !asset.archivedAt;
      
      return matchesQuery && matchesSection && matchesEntityType && matchesArchive;
    });
  }, [assets, entityNameByKey, query, sectionFilter, entityTypeFilter, showArchived]);

  // 거래처 ➔ 딜 ➔ 캠페인/테스크 계층을 반영하는 트리 구조 데이터 빌더
  const treeData = useMemo(() => {
    // 1. 거래처 맵 및 노드 생성
    const partnersMap = new Map<string, TreeNode>();
    const partnerInfoMap = new Map<string, { id: string; name: string }>();
    
    initialData.deals.forEach((deal) => {
      if (deal.partner) {
        partnerInfoMap.set(deal.partner.id, {
          id: deal.partner.id,
          name: deal.partner.name,
        });
      }
    });

    partnerInfoMap.forEach((p, id) => {
      partnersMap.set(id, {
        id: `partner:${id}`,
        name: `${p.name}`,
        type: "folder",
        folderType: "PARTNER",
        entityType: "PARTNER",
        entityId: id,
        children: [],
      });
    });

    // 2. 딜 맵 및 노드 생성
    const dealsMap = new Map<string, TreeNode>();
    initialData.deals.forEach((deal) => {
      const dealNode: TreeNode = {
        id: `deal:${deal.id}`,
        name: `${deal.dealName}`,
        type: "folder",
        folderType: "DEAL",
        entityType: "DEAL",
        entityId: deal.id,
        children: [],
      };
      dealsMap.set(deal.id, dealNode);

      // 거래처가 있으면 거래처 하위에 배치
      if (deal.partner && partnersMap.has(deal.partner.id)) {
        partnersMap.get(deal.partner.id)!.children.push(dealNode);
      }
    });

    // 3. 캠페인 노드 생성 및 배치
    const campaignsMap = new Map<string, TreeNode>();
    initialData.campaigns.forEach((campaign) => {
      const campaignNode: TreeNode = {
        id: `campaign:${campaign.id}`,
        name: `${campaign.campaignName || campaign.dealName} (${campaign.sellerName})`,
        type: "folder",
        folderType: "CAMPAIGN",
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        children: [],
      };
      campaignsMap.set(campaign.id, campaignNode);

      // 딜 하위에 배치
      if (campaign.dealId && dealsMap.has(campaign.dealId)) {
        dealsMap.get(campaign.dealId)!.children.push(campaignNode);
      }
    });

    // 4. 영업 테스크 노드 생성 및 배치
    const tasksMap = new Map<string, TreeNode>();
    (initialData.salesTasks ?? []).forEach((task) => {
      const taskNode: TreeNode = {
        id: `outreach:${task.id}`,
        name: `${task.dealName} - ${task.sellerName}`,
        type: "folder",
        folderType: "OUTREACH",
        entityType: "OUTREACH",
        entityId: task.id,
        children: [],
      };
      tasksMap.set(task.id, taskNode);

      // 딜 하위에 배치
      if (task.dealId && dealsMap.has(task.dealId)) {
        dealsMap.get(task.dealId)!.children.push(taskNode);
      }
    });

    // 5. 셀러 노드 생성
    const sellersMap = new Map<string, TreeNode>();
    initialData.sellers.forEach((seller) => {
      const sellerNode: TreeNode = {
        id: `seller:${seller.id}`,
        name: `${seller.name} (${seller.snsType})`,
        type: "folder",
        folderType: "SELLER",
        entityType: "SELLER",
        entityId: seller.id,
        children: [],
      };
      sellersMap.set(seller.id, sellerNode);
    });

    // 6. 기타/분류되지 않은 에셋 폴더 생성
    const othersFolder: TreeNode = {
      id: "folder:others",
      name: "분류되지 않은 에셋",
      type: "folder",
      folderType: "OTHERS",
      children: [],
    };

    // 7. 섹션 폴더 생성 자동화 함수
    const getOrCreateSectionFolder = (parent: TreeNode, section: AssetSection): TreeNode => {
      const sectionName = assetSectionLabels[section] || section;
      const sectionId = `${parent.id}:section:${section}`;
      let sectionNode = parent.children.find((child) => child.id === sectionId);
      if (!sectionNode) {
        sectionNode = {
          id: sectionId,
          name: `${sectionName}`,
          type: "folder",
          folderType: "SECTION",
          section: section,
          children: [],
        };
        parent.children.push(sectionNode);
      }
      return sectionNode;
    };

    // 8. filteredAssets를 트리에 배치
    filteredAssets.forEach((asset) => {
      const fileNode: TreeNode = {
        id: `file:${asset.id}`,
        name: asset.fileName,
        type: "file",
        asset: asset,
        children: [],
      };

      let placed = false;

      // entityType에 맞춰 알맞은 부모 노드 탐색
      if (asset.entityType === "PARTNER" && partnersMap.has(asset.entityId)) {
        const parent = partnersMap.get(asset.entityId)!;
        getOrCreateSectionFolder(parent, asset.section).children.push(fileNode);
        placed = true;
      } else if (asset.entityType === "DEAL" && dealsMap.has(asset.entityId)) {
        const parent = dealsMap.get(asset.entityId)!;
        getOrCreateSectionFolder(parent, asset.section).children.push(fileNode);
        placed = true;
      } else if (asset.entityType === "CAMPAIGN" && campaignsMap.has(asset.entityId)) {
        const parent = campaignsMap.get(asset.entityId)!;
        getOrCreateSectionFolder(parent, asset.section).children.push(fileNode);
        placed = true;
      } else if (asset.entityType === "OUTREACH" && tasksMap.has(asset.entityId)) {
        const parent = tasksMap.get(asset.entityId)!;
        getOrCreateSectionFolder(parent, asset.section).children.push(fileNode);
        placed = true;
      } else if (asset.entityType === "SELLER" && sellersMap.has(asset.entityId)) {
        const parent = sellersMap.get(asset.entityId)!;
        getOrCreateSectionFolder(parent, asset.section).children.push(fileNode);
        placed = true;
      }

      if (!placed) {
        getOrCreateSectionFolder(othersFolder, asset.section).children.push(fileNode);
      }
    });

    // 9. 루트 노드 리스트 구성
    const rootNodes: TreeNode[] = [];

    // 거래처 추가
    partnersMap.forEach((node) => rootNodes.push(node));

    // 딜 중 거래처가 없는 것 추가
    dealsMap.forEach((node) => {
      const hasPartner = initialData.deals.find(d => d.id === node.entityId)?.partner != null;
      if (!hasPartner) {
        rootNodes.push(node);
      }
    });

    // 캠페인 중 딜이 없는 것 추가
    campaignsMap.forEach((node) => {
      const campaign = initialData.campaigns.find(c => c.id === node.entityId);
      if (!campaign?.dealId || !dealsMap.has(campaign.dealId)) {
        rootNodes.push(node);
      }
    });

    // 테스크 중 딜이 없는 것 추가
    tasksMap.forEach((node) => {
      const task = (initialData.salesTasks ?? []).find(t => t.id === node.entityId);
      if (!task?.dealId || !dealsMap.has(task.dealId)) {
        rootNodes.push(node);
      }
    });

    // 셀러 추가
    sellersMap.forEach((node) => rootNodes.push(node));

    // 기타 폴더 추가 (자식이 있는 경우에만)
    if (othersFolder.children.length > 0) {
      rootNodes.push(othersFolder);
    }

    // 10. 빈 폴더를 재귀적으로 청소
    const cleanTree = (nodes: TreeNode[]): TreeNode[] => {
      return nodes
        .map((node) => {
          if (node.type === "file") return node;
          const cleanedChildren = cleanTree(node.children);
          return { ...node, children: cleanedChildren };
        })
        .filter((node) => {
          if (node.type === "file") return true;
          return node.children.length > 0;
        });
    };

    return cleanTree(rootNodes);
  }, [filteredAssets, initialData]);

  // 검색어가 포함된 경우 모든 관련 매칭 폴더를 자동으로 열어줍니다.
  useEffect(() => {
    if (query.trim().length > 0) {
      const allFolderIds = new Set<string>();
      const collectFolderIds = (nodes: TreeNode[]) => {
        nodes.forEach((node) => {
          if (node.type === "folder") {
            allFolderIds.add(node.id);
            collectFolderIds(node.children);
          }
        });
      };
      collectFolderIds(treeData);
      setOpenFolders(allFolderIds);
    }
  }, [query, treeData]);

  const toggleFolder = (folderId: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  async function connectDrive() {
    setBusy(true);
    const response = await fetch("/api/integrations/google-drive/connect", {
      method: "POST",
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      return;
    }
    window.location.href = data.authUrl;
  }

  async function openAsset(asset: AssetRow) {
    const response = await fetch(`/api/assets/${asset.id}?download=1`);
    const data = await response.json();
    if (data.downloadUrl) window.open(data.downloadUrl, "_blank", "noreferrer");
  }

  async function toggleArchiveAsset(asset: AssetRow) {
    const isArchived = !!asset.archivedAt;
    const msg = isArchived 
      ? `"${asset.fileName}" 자료를 보관 해제하여 다시 활성화하시겠습니까?`
      : `"${asset.fileName}" 자료를 보관하시겠습니까?\n보관된 자료는 목록에서 제외됩니다.`;
    
    const ok = window.confirm(msg);
    if (!ok) return;

    const response = await fetch(`/api/assets/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !isArchived }),
    });
    if (!response.ok) return;
    const data = await response.json();
    setAssets((previous) =>
      previous.map((item) => (item.id === asset.id ? data.asset : item)),
    );
  }

  async function renameAsset(asset: AssetRow) {
    const newName = window.prompt("변경할 파일명을 입력해주세요:", asset.fileName);
    if (!newName || newName.trim() === "" || newName === asset.fileName) return;

    const response = await fetch(`/api/assets/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: newName.trim() }),
    });
    if (!response.ok) {
      alert("파일명 수정에 실패했습니다.");
      return;
    }
    const data = await response.json();
    setAssets((previous) =>
      previous.map((item) => (item.id === asset.id ? data.asset : item)),
    );
  }

  // 중첩 트리 구조를 가상화 스크롤러에 적합한 1차원 평탄화(Flat) 배열로 변환하는 useMemo
  const flatVisibleNodes = useMemo<FlatNode[]>(() => {
    const list: FlatNode[] = [];

    const traverse = (nodes: TreeNode[], depth: number) => {
      nodes.forEach((node) => {
        const isOpen = openFolders.has(node.id);
        const hasChildren = node.children.length > 0;

        list.push({
          id: node.id,
          name: node.name,
          type: node.type,
          folderType: node.folderType,
          section: node.section,
          entityType: node.entityType,
          entityId: node.entityId,
          asset: node.asset,
          depth: depth,
          isOpen: isOpen,
          hasChildren: hasChildren,
        });

        // 폴더 노드가 열려있는 상태인 경우에만 자식 요소들을 재귀 평탄화에 추가합니다.
        if (node.type === "folder" && isOpen) {
          traverse(node.children, depth + 1);
        }
      });
    };

    traverse(treeData, 0);
    return list;
  }, [treeData, openFolders]);

  // @tanstack/react-virtual 가상화 윈도잉 훅 설정
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: flatVisibleNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44, // 각 행의 고정 높이 (px)
    overscan: 12, // 보이지 않는 위/아래 버퍼 여유 공간 렌더링 갯수
  });

  // 평탄화된 단일 노드 렌더러 함수
  const renderFlatNode = (node: FlatNode) => {
    if (node.type === "folder") {
      // 폴더 종류(거래처·딜·캠페인·영업·셀러)는 좋고 나쁨이 없는 **이름표**라 색을 받지 않는다
      // (P8 §4, 오너 결정 2026-07-30). 여기 있던 hue 7종 맵은 §4 가 정의하는 무지개 그 자체였고,
      // indigo·pink 는 StatusBadge SSOT 어휘 밖 hue 이기도 했다(가드레일 2). 구분은 아래 labelMap 이
      // 전담한다 — `settlement-channel-color-reclaim`(판매채널 4색 회수)과 같은 형태의 회수다.
      // 부수 효과로 `dark:` 변형 21개가 함께 사라졌다: 이 앱에는 ThemeProvider 도 classList 토글도
      // 없어(globals.css 주석 ".dark는 현재 미사용") 애초에 도달 불가한 죽은 클래스였다.
      const labelMap = {
        PARTNER: "거래처",
        DEAL: "딜",
        CAMPAIGN: "캠페인",
        OUTREACH: "영업",
        SELLER: "셀러",
        SECTION: "유형",
        OTHERS: "기타",
        ROOT: "루트"
      };

      return (
        <div key={node.id} className="select-none h-full flex items-center">
          <div
            className="flex items-center justify-between py-1.5 px-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-[background-color,scale] duration-150 gap-2 border border-transparent active:scale-[0.99] w-full"
            style={{ marginLeft: `${node.depth * 20}px` }}
            onClick={() => toggleFolder(node.id)}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-slate-400 shrink-0">
                {node.isOpen ? (
                  <FolderOpen className="size-4 text-amber-500 fill-amber-500/20" />
                ) : (
                  <Folder className="size-4 text-amber-400 fill-amber-400/10" />
                )}
              </span>
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 truncate">
                {node.name}
              </span>
              {node.folderType && node.folderType !== "SECTION" && node.folderType !== "OTHERS" && (
                <Badge variant="outline" className="text-[10px] py-0 px-1 shrink-0 font-medium">
                  {labelMap[node.folderType]}
                </Badge>
              )}
            </div>
            <div className="text-slate-400 text-xs shrink-0 flex items-center gap-1.5">
              {node.isOpen ? <ChevronDown className="size-3 text-slate-400" /> : <ChevronRight className="size-3 text-slate-400" />}
            </div>
          </div>
        </div>
      );
    } else {
      const asset = node.asset!;
      return (
        <div key={node.id} className="h-full flex items-center">
          <div
            className="flex items-center justify-between py-1 px-3 rounded-xl hover:bg-slate-50/70 border border-transparent hover:border-slate-100 dark:hover:bg-slate-800/20 dark:hover:border-slate-800/40 transition-colors duration-150 gap-3 w-full"
            style={{ marginLeft: `${node.depth * 20}px` }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="size-4 text-slate-400 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-600 dark:text-slate-300 truncate">
                    {node.name}
                  </span>
                  {asset.notes && (
                    <span className="text-[11px] text-slate-500 dark:text-slate-500 truncate max-w-[150px] md:max-w-[300px]">
                      - {asset.notes}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5 font-mono">
                  <span>{formatBytes(asset.sizeBytes)}</span>
                  <span>•</span>
                  <span className="text-slate-500 font-semibold">{assetProviderLabels[asset.provider]}</span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-lg size-7 hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => openAsset(asset)}
              >
                <ExternalLink className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={`rounded-lg size-7 ${asset.archivedAt ? "text-slate-500 hover:text-emerald-500 hover:bg-emerald-50" : "text-slate-500 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20"}`}
                onClick={() => toggleArchiveAsset(asset)}
                title={asset.archivedAt ? "보관 해제" : "보관"}
              >
                {asset.archivedAt ? (
                  <ArchiveRestore className="size-3.5" />
                ) : (
                  <Archive className="size-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    }
  };

  return (
    <CrmShell>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        {/* 1줄 통계 요약 바 (유리 박스 외부 상단 배치) */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-400 shrink-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <HardDrive className="size-3.5 text-slate-400" />
            <span className="font-medium">Supabase:</span>
            <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
              {formatBytes(initialData.storage.supabaseEstimatedBytes)}
            </span>
            <span className="text-[10px] text-slate-500">
              / {formatBytes(initialData.storage.supabaseLimitBytes)}
            </span>
          </div>
          <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <FolderOpen className="size-3.5 text-slate-400" />
            <span className="font-medium">Google Drive:</span>
            <span className={`font-semibold ${initialData.storage.googleDriveConnected ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
              {initialData.storage.googleDriveConnected ? "연결됨" : "미연결"}
            </span>
            {initialData.storage.googleDriveAccount && (
              <span className="text-[10px] text-slate-500 font-mono font-normal">({initialData.storage.googleDriveAccount})</span>
            )}
          </div>
          <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <FileText className="size-3.5 text-slate-400" />
            <span className="font-medium">등록 자료:</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">{assets.length}건</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {/* 탑바 (타 워크스페이스와 일관성 확보) */}
          <section className="flex min-h-12 shrink-0 items-center justify-between border-b border-border/70 px-5 py-3 bg-white/40 gap-3">
            <div className="flex-1">
              <h2 className="text-sm font-bold text-foreground">자료 목록</h2>
            </div>
            
            <div className="flex items-center gap-3">
              <InputGroup className="w-48 shrink-0 border border-slate-200 bg-white h-9 rounded-lg shadow-soft-sm">
                <InputGroupAddon>
                  <Search className="h-4 w-4 text-slate-400" />
                </InputGroupAddon>
                <InputGroupInput
                  placeholder="파일명, 메모 검색..."
                  value={localQuery}
                  onChange={(event) => {
                    const val = event.target.value;
                    setLocalQuery(val);
                    debouncedSetFilter(val);
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    isComposingRef.current = false;
                    setFilter("q", event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !isComposingRef.current) {
                      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                      setFilter("q", localQuery);
                    }
                  }}
                  className="h-full text-xs"
                />
              </InputGroup>

              <Button
                variant={showArchived ? "secondary" : "outline"}
                size="sm"
                className={`h-9 rounded-lg transition-[color,background-color,border-color,font-weight] text-xs shrink-0 ${
                  showArchived 
                    ? "bg-amber-50 text-amber-700 border-amber-200/60 hover:bg-amber-100/80 hover:text-amber-800 font-semibold" 
                    : "bg-white text-slate-600 hover:text-slate-800 border-slate-200"
                }`}
                onClick={() => setShowArchived(!showArchived)}
                title={showArchived ? "활성 자료 보기" : "보관 자료 보기"}
              >
                <ArchiveRestore className="size-3.5 mr-1.5" />
                보관자료 보기
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-lg border-slate-200 bg-white text-xs shrink-0"
                asChild
              >
                <Link href="/">
                  <FolderOpen data-icon="inline-start" />
                  캠페인
                </Link>
              </Button>
              <Button
                size="sm"
                className="h-9 rounded-lg bg-primary px-3.5 text-xs text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/95 shrink-0"
                onClick={connectDrive}
                disabled={busy}
              >
                <RefreshCcw data-icon="inline-start" />
                Drive 연결
              </Button>
            </div>
          </section>
          
          {/* 본문 콘텐츠 스크롤 영역 */}
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">

          {driveStatus === "connected" ? (
            <DataSourceBanner
              tone="success"
              message="Google Drive 연결이 완료되었습니다. 이제 장기 보관 자료를 Drive로 올릴 수 있습니다."
            />
          ) : null}
          {driveStatus === "error" ? (
            <DataSourceBanner
              tone="error"
              message="Google Drive 연결이 완료되지 않았습니다. OAuth 승인 또는 callback 설정을 다시 확인하세요."
            />
          ) : null}
          {initialData.dataSource === "mock" && initialData.dataSourceMessage ? (
            <DataSourceBanner message={initialData.dataSourceMessage} />
          ) : null}

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center justify-between border-b border-slate-100 pb-3">
              {/* 왼쪽: 필터 셀렉트 박스 2개 */}
              <div className="flex items-center gap-2">
                <Select
                  value={entityTypeFilter}
                  onValueChange={(value) => setFilter("entityTypeFilter", value)}
                >
                  <SelectTrigger className="w-full rounded-lg border-slate-200 bg-white h-9 md:w-36 text-xs shadow-soft-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">전체 대상</SelectItem>
                    <SelectItem value="PARTNER">거래처</SelectItem>
                    <SelectItem value="DEAL">딜</SelectItem>
                    <SelectItem value="SELLER">셀러</SelectItem>
                    <SelectItem value="OUTREACH">영업 테스크</SelectItem>
                    <SelectItem value="CAMPAIGN">캠페인</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={sectionFilter}
                  onValueChange={(value) => setFilter("sectionFilter", value)}
                >
                  <SelectTrigger className="w-full rounded-lg border-slate-200 bg-white h-9 md:w-36 text-xs shadow-soft-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">전체 유형</SelectItem>
                    {sectionValues.map((value) => (
                      <SelectItem key={value} value={value}>
                        {assetSectionLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 오른쪽: 뷰 모드 조절 및 3/4열 조절 */}
              <div className="flex items-center gap-2.5 self-end md:self-auto shrink-0">
                {viewMode === "gallery" && (
                  <div className="flex gap-0.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200/50">
                    <Button
                      variant={galleryCols === 3 ? "secondary" : "ghost"}
                      size="sm"
                      className={`px-2 py-0.5 text-[10px] font-medium rounded-md transition-[color,background-color,box-shadow] h-5.5 ${
                        galleryCols === 3
                          ? "bg-white text-slate-800 shadow-soft-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                      onClick={() => changeGalleryCols(3)}
                    >
                      3열
                    </Button>
                    <Button
                      variant={galleryCols === 4 ? "secondary" : "ghost"}
                      size="sm"
                      className={`px-2 py-0.5 text-[10px] font-medium rounded-md transition-[color,background-color,box-shadow] h-5.5 ${
                        galleryCols === 4
                          ? "bg-white text-slate-800 shadow-soft-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                      onClick={() => changeGalleryCols(4)}
                    >
                      4열
                    </Button>
                  </div>
                )}
                <div className="flex gap-1 shrink-0 bg-slate-100 p-1 rounded-lg border border-slate-200/50">
                  <Button
                    variant={viewMode === "gallery" ? "secondary" : "ghost"}
                    size="sm"
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-[color,background-color,box-shadow] h-7 ${
                      viewMode === "gallery"
                        ? "bg-white text-slate-800 shadow-soft-sm"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                    onClick={() => changeViewMode("gallery")}
                  >
                    <LayoutGrid className="size-3.5 mr-1" />
                    갤러리형
                  </Button>
                  <Button
                    variant={viewMode === "list" ? "secondary" : "ghost"}
                    size="sm"
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-[color,background-color,box-shadow] h-7 ${
                      viewMode === "list"
                        ? "bg-white text-slate-800 shadow-soft-sm"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                    onClick={() => changeViewMode("list")}
                  >
                    <List className="size-3.5 mr-1" />
                    리스트형
                  </Button>
                  <Button
                    variant={viewMode === "tree" ? "secondary" : "ghost"}
                    size="sm"
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-[color,background-color,box-shadow] h-7 ${
                      viewMode === "tree"
                        ? "bg-white text-slate-800 shadow-soft-sm"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                    onClick={() => changeViewMode("tree")}
                  >
                    <FolderTree className="size-3.5 mr-1" />
                    폴더 트리형
                  </Button>
                </div>
              </div>
            </div>
              {viewMode === "gallery" ? (
                <div className={galleryCols === 3 
                  ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" 
                  : "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
                }>
                  {filteredAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-300 hover:shadow-soft-sm transition-[border-color,box-shadow] min-h-[105px]"
                    >
                      <div className="min-w-0">
                        {/* 1줄: 파일형식 아이콘 + 파일명 및 수정 버튼 */}
                        <div className="flex items-start justify-between gap-2 min-w-0 group/title">
                          <div className="flex items-start gap-2 min-w-0 flex-1">
                            <div className="mt-0.5 shrink-0">
                              {getFileIcon(asset.mimeType, asset.fileName)}
                            </div>
                            <p 
                              className="truncate text-sm font-semibold text-slate-800 group-hover:text-primary transition-colors cursor-pointer" 
                              onClick={() => openAsset(asset)}
                              title={asset.fileName}
                            >
                              {asset.fileName}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="size-5 opacity-0 group-hover/title:opacity-100 transition-opacity rounded-md shrink-0 text-slate-500 hover:text-slate-700"
                            onClick={(e) => {
                              e.stopPropagation();
                              renameAsset(asset);
                            }}
                            title="파일명 수정"
                          >
                            <Pencil className="size-3" />
                          </Button>
                        </div>
                        
                        {/* 2줄: 업로드 근원 거래처 및 세부 정보 */}
                        {(() => {
                          const { badgeText, primaryName, secondaryName } = getAssetOriginInfo(
                            asset, 
                            entityNameByKey, 
                            entityPartnerMap
                          );
                          return (
                            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] min-w-0">
                              {/* 위 트리 뷰 폴더 배지와 **같은 라벨 어휘**(거래처·딜·캠페인·영업·셀러)라
                                  같은 중립 outline 을 쓴다(P8 §4, 오너 결정 2026-07-30). 회수 전에는 한
                                  파일 안에서 같은 범주가 트리=hue 7종, 카드=단색 indigo 로 갈려 있었다. */}
                              <span className="text-[9px] text-foreground px-1 py-0.5 rounded font-medium border border-border shrink-0">
                                {badgeText}
                              </span>
                              <span className="font-semibold text-slate-700 truncate" title={primaryName}>
                                {primaryName}
                              </span>
                              {secondaryName && (
                                <>
                                  <span className="text-slate-300 shrink-0">›</span>
                                  <span className="text-slate-500 truncate text-[10px]" title={secondaryName}>
                                    {secondaryName}
                                  </span>
                                </>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* 3줄: 뱃지 + 메타데이터 및 액션 */}
                      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-muted-foreground gap-2">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <Badge variant="secondary" className="px-1 py-0 text-[9px] bg-slate-100 hover:bg-slate-100 text-slate-600 border-none font-normal shrink-0">
                            {assetSectionLabels[asset.section]}
                          </Badge>
                          <Badge variant="outline" className="px-1 py-0 text-[9px] border-slate-200 bg-slate-50 text-slate-500 font-normal shrink-0">
                            {assetProviderLabels[asset.provider]}
                          </Badge>
                          <span className="shrink-0 font-mono">{formatBytes(asset.sizeBytes)}</span>
                        </div>
                        
                        <div className="flex shrink-0 gap-0.5">
                          <Button 
                            variant="ghost" 
                            size="icon-xs" 
                            className="size-6 rounded-md hover:bg-slate-100 hover:text-slate-800" 
                            onClick={() => openAsset(asset)}
                            title="열기"
                          >
                            <ExternalLink className="size-3" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon-xs" 
                            className={`size-6 rounded-md hover:bg-slate-100 ${asset.archivedAt ? "hover:text-emerald-600" : "hover:text-rose-600"}`}
                            onClick={() => toggleArchiveAsset(asset)}
                            title={asset.archivedAt ? "보관 해제" : "보관"}
                          >
                            {asset.archivedAt ? (
                              <ArchiveRestore className="size-3" />
                            ) : (
                              <Archive className="size-3" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {filteredAssets.length === 0 ? (
                    <DataEmpty title="조건에 맞는 자료가 없습니다." className="col-span-full py-6" />
                  ) : null}
                </div>
              ) : viewMode === "list" ? (
                <div className="space-y-2">
                  {filteredAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 shrink-0 text-muted-foreground" />
                          <p className="truncate text-sm font-medium">{asset.fileName}</p>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="outline" className="border-slate-200 bg-slate-50">
                            {assetProviderLabels[asset.provider]}
                          </Badge>
                          <Badge variant="secondary" className="px-1.5 py-0.5 text-[10px]">
                            {asset.entityType === "PARTNER" ? "거래처" :
                             asset.entityType === "DEAL" ? "딜" :
                             asset.entityType === "SELLER" ? "셀러" :
                             asset.entityType === "OUTREACH" ? "영업 테스크" : "캠페인"}
                          </Badge>
                          <span className="text-slate-200">|</span>
                          <span>{assetSectionLabels[asset.section]}</span>
                          <span className="text-slate-200">|</span>
                          <span className="font-semibold text-slate-700">{entityNameByKey.get(`${asset.entityType}:${asset.entityId}`) ?? asset.entityId}</span>
                          <span className="text-slate-200">|</span>
                          <span>{formatBytes(asset.sizeBytes)}</span>
                          {asset.externalUrl ? <LinkIcon className="size-3" /> : null}
                        </div>
                        {asset.notes ? (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {asset.notes}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon-sm" className="rounded-lg" onClick={() => openAsset(asset)}>
                          <ExternalLink />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon-sm" 
                          className={`rounded-lg ${asset.archivedAt ? "hover:text-emerald-600" : "hover:text-rose-600"}`}
                          onClick={() => toggleArchiveAsset(asset)}
                          title={asset.archivedAt ? "보관 해제" : "보관"}
                        >
                          {asset.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {filteredAssets.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-sm text-muted-foreground">
                      조건에 맞는 자료가 없습니다.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div 
                  ref={parentRef}
                  className="rounded-xl border border-slate-200 bg-white dark:bg-slate-900 p-4 overflow-y-auto max-h-[600px] scrollbar-thin"
                >
                  {flatVisibleNodes.length > 0 ? (
                    <div
                      style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                        const node = flatVisibleNodes[virtualItem.index];
                        if (!node) return null;
                        return (
                          <div
                            key={node.id}
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              height: `${virtualItem.size}px`,
                              transform: `translateY(${virtualItem.start}px)`,
                            }}
                          >
                            {renderFlatNode(node)}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 dark:bg-slate-950 p-6 text-sm text-muted-foreground text-center">
                      계층 구조 내에 표시할 자료가 없습니다.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </CrmShell>
  );
}
