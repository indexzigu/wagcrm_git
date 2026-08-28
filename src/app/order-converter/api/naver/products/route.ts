
import { NextRequest, NextResponse } from 'next/server';
import { searchNaverProducts } from '@/lib/order-converter/naver-commerce-api';

export async function GET(request: NextRequest) {
  void request.url;
  try {
    const data = await searchNaverProducts();
    const contents = data.contents || [];

    return NextResponse.json({
      success: true,
      products: contents
    });
  } catch (error: any) {
    console.error('Failed to fetch Naver products:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
