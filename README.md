# FabAssure

**Change → Verify → Evidence → Review → Accept**

FabAssure는 제조 변경을 어떤 기준과 근거로 검증·승인했는지 하나의 이력으로 연결하는 오프라인 품질 데모입니다. 변경 관리, 이상 영향 추적, CAPA, 효과성 확인과 감사 기록을 로컬에서 살펴볼 수 있습니다.

![FabAssure 개요 화면](media/overview.png)

## 핵심 기능

- 변경 위험 분류, 승인된 검증 기준, 측정·AOI 원천 근거 연결
- 요청자·검토자·승인자 분리와 서버의 상태 전이·권한 검사
- 설비 이력과 마지막 정상 관측을 이용한 영향 LOT 추적
- CAPA 조치, 관리 문서 피드백, 종결·재개 및 효과성 확인 이력
- 조건부 수락 만료와 과거 수락의 분류 필요 상태를 보수적으로 처리

## 시작하기

Windows x64에서 인터넷 없이 실행할 수 있는 번들은 [배포 안내](README_FIRST_KO.md)를 따릅니다. 소스에서 번들을 만들려면 공식 Node.js **v24.19.0 Windows x64** ZIP을 별도로 준비한 뒤 PowerShell에서 다음을 실행하세요.

```powershell
.\scripts\build-portable.ps1 -NodeArchive <공식-Node-ZIP-경로> -OutputDirectory .\dist\FabAssure
.\dist\FabAssure\verify-offline.cmd
.\dist\FabAssure\start-fabassure.cmd
```

브라우저에서 `http://127.0.0.1:4310`을 열고 **변경 관리 → FabTrace → 설비 이력 → 데모 정보**를 살펴보세요. 자세한 순서는 [데모 가이드](docs/demo-guide.md)에 있습니다.

## 구조와 검증

[아키텍처](docs/architecture.md) · [업무 흐름](docs/workflow.md) · [검증 결과](docs/validation.md) · [한계](docs/limitations.md)

이 제품은 샘플 데이터와 모의 역할을 사용합니다. 실제 MES·설비와 연결되지 않으며 운영 승인에 사용할 수 없습니다. 개발 과정의 도구 사용과 검증 방법은 [개발 방법](docs/development-method.md)에 간략히 기록했습니다.
