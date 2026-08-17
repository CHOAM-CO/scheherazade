# User-facing changes, one short section per version

<!-- Read by harness-render's computeUpdateBrief(): after an app update,
     the sections BETWEEN the previously-briefed version and the current
     one are handed to the agent so she can mention what changed in one
     natural sentence. Write for the USER, in Korean, one or two lines —
     never a changelog dump. The release runbook (docs/RELEASE.md) appends
     a section here per release; missing versions simply brief as a bare
     version bump. -->

## 0.1.15
이제 예약 작업(Schedules)에 항목을 넣으면 에이전트가 정해진 시간에 스스로 움직여요 —
에이전트가 직접 만든 예약은 자율 모드를 켜줘야만 발동합니다. 새벽에는 일주일치 기억을
정리해서 메모리 화면의 "What I remember"를 새로 써두고, 기억 검색이 인물/이름 단위로
연결돼 더 잘 찾아요. 그리고 SSH 키나 브라우저 암호 저장소 같은 민감한 파일은 에이전트가
아예 읽을 수 없게 자동 차단됩니다.

## 0.1.14
이 컴퓨터에 있는 다른 AI 도구의 전역 설정 파일이 에이전트한테 몰래 섞여 들어가던
문제를 고쳤어요 — 다른 에이전트의 이름이나 말투를 자기 것으로 착각하는 일이 더는
없습니다. 그 파일의 내용이 필요하면 설정의 Hand it Over로 정식으로 넘겨받으면 돼요.

## 0.1.13
이제 이름을 바꿔도 예전 이름 시절의 일기가 "전임자의 기록"으로 구분돼요 — 에이전트가
과거의 다른 이름을 자기라고 착각하지 않습니다. 그리고 앱이 업데이트되면 에이전트가
직접 뭐가 바뀌었는지 한 줄로 알려줘요 (지금 이 메시지처럼요).

## 0.1.12
맥이 잠들었다 깨어난 뒤에 멀쩡한 세션이 Fail로 표시되던 버그를 고쳤어요. 이제
창을 내려놓고 자리를 비워도 세션이 죽지 않습니다.

## 0.1.11
스킬이 앱 업데이트를 따라 자동 갱신되고, 백그라운드에서 온 답장은 OS 알림으로
알려줍니다.
