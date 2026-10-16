// Static companion copy follows the page language, not the operating system.
;(function () {
  if (!document.documentElement.lang.startsWith('ko')) return
  const translations = {
  "Talk to Sera": "세라와 이야기하기",
  "Click to talk. Drag to move.": "눌러서 이야기하기 · 끌어서 옮기기",
  "Sera, sound only": "세라 · 소리만",
  "Click to talk or pause speech. Drag to move.": "눌러서 이야기하기 · 읽는 중이면 잠시 멈춤 · 끌어서 옮기기",
  "Companion controls": "컴패니언 조작",
  "Turn companion off": "컴패니언 끄기",
  "Stop reading": "읽기 멈춤",
  "Voice input": "음성 입력",
  "Conversation with Sera": "세라의 이야기",
  "These buttons send a chat reply. They do not change tool permissions.": "아래 버튼은 채팅 답장을 보내요. 도구 실행 권한을 바꾸지는 않아요.",
  "Reply with approval": "허용한다고 답하기",
  "Reply with refusal": "거절한다고 답하기",
  "Send reply": "답장 보내기",
  "Press Enter to send": "Enter로 보내기",
  "Type a reply": "짧게 답해 주세요",
  "Open in app": "앱에서 보기",
  "Reply": "답장"
}
  for (const el of document.querySelectorAll('body *')) {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr)
      if (translations[value]) el.setAttribute(attr, translations[value])
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && translations[node.textContent]) node.textContent = translations[node.textContent]
    }
  }
})()
