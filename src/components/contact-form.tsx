"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { toast } from "sonner"
import { SendIcon } from "lucide-react"

/**
 * 프리미엄 디자인이 적용된 문의 폼 컴포넌트입니다.
 * shadcn v4의 Field 시스템과 카드 레이아웃을 사용합니다.
 */
export function ContactForm() {
  const [isPending, setIsPending] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsPending(true)

    try {
      // API 호출 시뮬레이션
      await new Promise((resolve) => setTimeout(resolve, 1500))
      
      toast.success("메시지가 성공적으로 전송되었습니다.", {
        description: "최대한 빨리 답변해 드리겠습니다.",
      })
      
      const form = event.target as HTMLFormElement
      form.reset()
    } catch {
      toast.error("전송에 실패했습니다. 다시 시도해 주세요.")
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Card className="w-full max-w-lg mx-auto overflow-hidden border-none shadow-overlay ring-1 ring-foreground/5 bg-background/50 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-500">
      <CardHeader className="relative pb-8 pt-10 text-center">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/5 -z-10" />
        <CardTitle className="text-3xl font-heading tracking-tight mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
          문의하기
        </CardTitle>
        <CardDescription className="text-base text-muted-foreground max-w-[280px] mx-auto">
          궁금한 점이 있으신가요? 메시지를 남겨주시면 빠르게 답변해 드리겠습니다.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="grid gap-6 px-8 pb-8">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">이름</FieldLabel>
              <Input
                id="name"
                name="name"
                placeholder="홍길동"
                required
                className="h-11 bg-muted/30 border-muted-foreground/10 focus-visible:ring-focus-ring transition-[color,box-shadow] duration-200"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">이메일</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="name@example.com"
                required
                className="h-11 bg-muted/30 border-muted-foreground/10 focus-visible:ring-focus-ring transition-[color,box-shadow] duration-200"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="message">메시지</FieldLabel>
              <Textarea
                id="message"
                name="message"
                placeholder="문의 내용을 입력해주세요..."
                required
                className="min-h-[120px] bg-muted/30 border-muted-foreground/10 focus-visible:ring-focus-ring transition-[color,box-shadow] duration-200 resize-none"
              />
              <FieldDescription>
                최대한 구체적으로 작성해 주시면 정확한 답변에 도움이 됩니다.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="px-8 pb-10">
          <Button
            type="submit"
            className="w-full h-12 text-base font-medium shadow-lg shadow-primary/10 relative overflow-hidden group/btn"
            disabled={isPending}
          >
            {isPending ? (
              <span className="flex items-center gap-2">
                <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                전송 중...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                메시지 보내기
                <SendIcon className="size-4 transition-transform duration-300 group-hover/btn:translate-x-1 group-hover/btn:-translate-y-1" />
              </span>
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
