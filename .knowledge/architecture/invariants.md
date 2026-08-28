---
type: concept
title: Alex's 8 Invariants (Backend)
description: The structural truth and core engineering invariants guiding the wag-crm backend architecture.
tags: [architecture, principles, backend]
timestamp: "2026-06-16T13:35:00+09:00"
---

# Alex's 8 Invariants

These core invariants are the absolute truths for backend engineering in this project. All code reviews, feature additions, and architectural decisions must strictly adhere to these principles to maintain systemic integrity.

## 1. Single Source of Truth (SSoT)
- 여러 곳에 중복된 상태/진실이 생성되거나 캐시가 본질을 덮어쓰지 않아야 합니다.
- 데이터베이스 스키마와 상태 관리 로직은 단일 진실 공급원 원칙을 준수합니다.

## 2. Atomicity & Idempotency
- 트랜잭션이 절반만 반영된 상태로 남거나, 동일한 동작의 재시도 시 데이터가 오염되지 않아야 합니다.
- 분산 시스템 통신이나 재시도 로직에서 멱등성(Idempotency)을 보장합니다.

## 3. Separation of Concerns (SoC) / SRP
- 한계치 이상의 관심사가 하나의 모듈이나 함수에 섞이지 않아야 합니다.
- 각 서비스/도메인 계층의 역할과 책임이 명확히 분리되어야 합니다.

## 4. No Silent Fallback
- 에러나 실패를 숨긴 채 레거시 경로나 섀도우 패스로 몰래 우회하는 로직(빈 `catch` 블록 등)을 철저히 금지합니다.
- 오류는 조기에(fail-fast) 명시적으로 로깅하고 처리해야 합니다.

## 5. Simplicity First (No Over-engineering)
- 단 1회 쓰이는 로직을 위해 불필요한 추상화나 확장성이 도입되지 않았는지 항상 점검합니다.
- 복잡성은 필연적인 경우에만 허용됩니다.

*(Add remaining invariant context specific to backend here if needed)*
