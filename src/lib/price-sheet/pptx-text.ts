/**
 * pptx → 슬라이드별 텍스트 추출 (Phase 3 청사진 §2 경로 B, R-A).
 *
 * pptx는 OOXML zip 컨테이너다. 렌더링/이미지 변환 없이 `ppt/slides/slideN.xml` 안의
 * `<a:t>...</a:t>` 텍스트 런만 정규식으로 뽑아도 표 안 수치·정책 문구가 전부 보존됨을
 * 실제 픽스처(igojin_climber_proposal.pptx)로 실증했다 — 슬라이드 5장 전 필드 검출.
 *
 * xlsx 라이브러리의 parse_zip은 워크북 포맷(ODS/CFB) 전용이라 임의 zip 파일 목록을
 * 열거하는 범용 API가 없다 — 실측 확인(XLSX.read가 pptx 버퍼에 "Could not find workbook"
 * 오류). exceljs의 전이의존성으로 이미 존재하는 jszip(3.10.1)을 package.json 직접
 * 의존성으로 승격해 재사용한다(청사진 R-A, 관제탑 승인됨).
 */
import JSZip from "jszip";

export type SlideText = {
  slideIndex: number; // 1-based (파일명 slideN.xml의 N)
  text: string; // 해당 슬라이드의 <a:t> 텍스트 런을 순서대로 join
};

const SLIDE_PATH_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE = /<a:t>([^<]*)<\/a:t>/g;

// m3: 슬라이드 XML의 압축 해제 후 크기 상한. zip bomb(작은 압축 크기로 거대한 압축 해제
// 결과를 유발하는 악성/손상 pptx)에 대비해, 정상적인 슬라이드 텍스트 XML이 절대 도달할 수
// 없는 크기(10MB)를 넘는 슬라이드는 텍스트 추출을 스킵하고 경고만 남긴다 — 서버 메모리를
// 통째로 소진하는 사고를 막기 위함이다.
const MAX_SLIDE_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10MB

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTextRuns(xml: string): string[] {
  const runs: string[] = [];
  let match: RegExpExecArray | null;
  TEXT_RUN_RE.lastIndex = 0;
  while ((match = TEXT_RUN_RE.exec(xml)) !== null) {
    const text = decodeXmlEntities(match[1]);
    if (text.length > 0) runs.push(text);
  }
  return runs;
}

/**
 * pptx 버퍼에서 슬라이드 순서대로 텍스트를 추출한다.
 * 슬라이드 안에서는 <a:t> 등장 순서를 그대로 보존하고, 텍스트 런 사이에 공백을 넣어
 * "예상 공구가" + ": 99,000" + "원" 같은 분절된 런이 문맥상 이어지도록 한다.
 */
export async function extractPptxSlideTexts(buffer: Buffer | ArrayBuffer): Promise<SlideText[]> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .map((name) => {
      const m = name.match(SLIDE_PATH_RE);
      return m ? { name, index: Number(m[1]) } : null;
    })
    .filter((v): v is { name: string; index: number } => v !== null)
    .sort((a, b) => a.index - b.index);

  const slides: SlideText[] = [];
  for (const { name, index } of slideFiles) {
    const file = zip.files[name];
    // m3: JSZip이 압축 해제 전에 알고 있는 크기(_data.uncompressedSize)를 먼저 확인한다.
    // 실제로 async("string")을 호출해 압축을 풀기 *전에* 검사해야 zip bomb 방지 효과가 있다.
    const uncompressedSize = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof uncompressedSize === "number" && uncompressedSize > MAX_SLIDE_UNCOMPRESSED_BYTES) {
      console.warn(
        `[pptx-text] slide${index}.xml 압축 해제 크기(${uncompressedSize}바이트)가 상한(${MAX_SLIDE_UNCOMPRESSED_BYTES}바이트)을 초과해 스킵합니다.`
      );
      continue;
    }
    const xml = await file.async("string");
    const runs = extractTextRuns(xml);
    slides.push({ slideIndex: index, text: runs.join(" ") });
  }
  return slides;
}

/** 슬라이드 텍스트 배열을 LLM 프롬프트용 단일 문자열로 합친다. */
export function slidesToPromptText(slides: SlideText[]): string {
  return slides.map((s) => `[슬라이드 ${s.slideIndex}]\n${s.text}`).join("\n\n");
}
