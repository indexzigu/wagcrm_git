import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from 'officecrypto-tool';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const password = formData.get('password') as string || '0000';

    if (!file) {
      return NextResponse.json({ error: '파일이 제공되지 않았습니다.' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let decryptedBuffer: Buffer;
    try {
      decryptedBuffer = await decrypt(buffer, { password });
    } catch (err: any) {
      console.error('복호화 시도 중 예외 발생:', err);
      return NextResponse.json({ error: `비밀번호가 틀렸거나 지원되지 않는 엑셀 형식입니다: ${err.message}` }, { status: 400 });
    }

    return new NextResponse(new Uint8Array(decryptedBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="decrypted.xlsx"'
      }
    });
  } catch (error: any) {
    console.error('Decryption error:', error);
    return NextResponse.json({ error: '엑셀 복호화 처리 중 서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
