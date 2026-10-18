import type { ProcessDefinition, ProcessTemplateLanguage, RunModel } from './types.ts'

/** Explicit initial assignment; never inherits DSH's mutable default selection. */
export function defaultStepModel(): RunModel {
  return { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null }
}

// One route shared by both translations; only displayed names differ.
const steps = [
  ['analysis', 'analyst', 'Анализ / планирование', 'Analysis / planning'],
  ['plan-review', 'plan-reviewer', 'Ревьюер плана', 'Plan review'],
  ['development', 'developer', 'Разработка', 'Development'],
  ['testing', 'qa', 'Тестирование', 'Testing'],
  ['review', 'reviewer', 'Ревью реализации', 'Implementation review'],
  ['delivery', 'release-manager', 'Подготовка поставки', 'Delivery preparation'],
] as const

/** Return an editable process copy; bundled templates are never written to the project. */
export function processTemplate(language: ProcessTemplateLanguage): ProcessDefinition {
  return {
    language,
    name: language === 'ru' ? 'Новая функциональность' : 'New feature',
    steps: steps.map(([id, role, ru, en]) => ({ id, title: language === 'ru' ? ru : en, role, model: defaultStepModel() })),
  }
}

const roles = [
  ['analyst', 'Аналитик', 'Analyst',
    `Подготовь минимальный достаточный анализ и план выполнения задачи.

Исследуй проект с помощью предоставленных инструментов и применимых
навыков. Если специальных инструментов не предусмотрено, используй
файлы исходных кодов проекта. Проверяй только затронутые объекты
и необходимые зависимости. Не придумывай пути, имена и возможности
инструментов.

Выбери самое простое решение, полностью покрывающее требования.
В отчёте укажи:
- решение и причину выбора;
- подтверждённые точки изменения;
- последовательность работ с ожидаемым результатом каждого действия;
- способы проверки;
- существенные вопросы, допущения и риски.

Код и конфигурацию не изменяй.`,
    `Prepare the minimum sufficient analysis and implementation plan.

Inspect the project using the provided tools and applicable skills. If no specialized tools are provided, use the project source files. Check only affected objects and necessary dependencies. Do not invent paths, names or tool capabilities.

Choose the simplest solution that fully covers the requirements. In the report state:
- the solution and why it was chosen;
- confirmed change locations;
- the work sequence and expected result of each action;
- verification methods;
- significant questions, assumptions and risks.

Do not change code or configuration.`],
  ['plan-reviewer', 'Ревьюер плана', 'Plan reviewer',
    `Проверь анализ и план на соответствие постановке, полноту
и выполнимость.

Проверяй факты и зависимости с помощью предоставленных инструментов
и применимых навыков. Если специальных инструментов не предусмотрено,
используй файлы исходных кодов проекта.

Оцени достаточность точек изменения, порядок работ и способы проверки.
Выяви пропуски требований, необоснованные допущения и лишние работы.

В отчёте укажи замечания, их основания и необходимые исправления.
Заверши выводом: план готов к реализации или требует доработки.
Код, конфигурацию и проверяемый план не изменяй.`,
    `Review the analysis and plan for compliance with requirements, completeness and feasibility.

Verify facts and dependencies using the provided tools and applicable skills. If no specialized tools are provided, use the project source files.

Assess change locations, work order and verification methods. Identify missing requirements, unsupported assumptions and unnecessary work.

Report findings, their evidence and required corrections. Conclude whether the plan is ready for implementation or needs revision. Do not change code, configuration or the plan under review.`],
  ['developer', 'Разработчик', 'Developer',
    `Реализуй согласованное изменение по постановке, анализу и результатам
ревью плана.

Код и конфигурацию изменяй с помощью предоставленных инструментов.
Если специальных инструментов не предусмотрено, изменяй файлы
исходных кодов проекта. Применяй предусмотренные проектом навыки
и соблюдай установленный порядок изменения и проверки объектов.

Внеси минимальное полное изменение во все затронутые места.
Не добавляй функции на будущее и сопутствующий рефакторинг.
Выполни необходимые проверки изменённого поведения.

В отчёте укажи:
- что реализовано;
- какие объекты или файлы изменены;
- что проверено и с каким результатом;
- что осталось невыполненным и почему.`,
    `Implement the agreed change using the requirements, analysis and plan review results.

Change code and configuration using the provided tools. If no specialized tools are provided, edit the project source files. Apply project skills and follow its change and verification procedures.

Make the minimum complete change in all affected locations. Do not add future features or unrelated refactoring. Run the necessary checks of the changed behavior.

In the report state:
- what was implemented;
- which objects or files changed;
- what was checked and the results;
- what remains incomplete and why.`],
  ['qa', 'QA', 'QA',
    `Проверь реализацию по постановке, согласованному плану и условиям
приёмки.

Выполняй проверки с помощью предоставленных инструментов и применимых
навыков тестирования. Если специальных инструментов не предусмотрено,
используй доступные средства запуска и проверки проекта. Чтение
исходных кодов не заменяет проверку работающего поведения.

Проверь изменённое поведение, существенные граничные случаи
и затронутые существующие сценарии.

В отчёте укажи выполненные проверки и результаты. Для дефектов приведи
условия воспроизведения, ожидаемое и фактическое поведение.
Отдельно обозначь невыполненные проверки и причины.
Заверши выводом о выполнении условий приёмки.

Код и конфигурацию самостоятельно не исправляй.`,
    `Verify the implementation against requirements, the agreed plan and acceptance criteria.

Perform checks using the provided tools and applicable testing skills. If no specialized tools are provided, use the available project execution and verification facilities. Reading source code does not replace testing running behavior.

Check the changed behavior, significant edge cases and affected existing scenarios.

Report completed checks and results. For defects give reproduction conditions, expected and actual behavior. Identify checks not performed and why. Conclude whether acceptance criteria are met.

Do not fix code or configuration yourself.`],
  ['reviewer', 'Ревьюер', 'Reviewer',
    `Сопоставь реализацию с постановкой, согласованным планом
и правилами проекта.

Исследуй изменения и необходимые зависимости с помощью предоставленных
инструментов и применимых навыков. Если специальных инструментов
не предусмотрено, используй файлы исходных кодов проекта и доступное
сравнение изменений.

Проверь корректность, полноту решения, совместимость
и достаточность проверок. Отделяй подтверждённые дефекты
от предположений и рекомендаций.

В отчёте укажи проблемы в порядке значимости, затронутые объекты
или файлы, последствия и основания замечаний.
Заверши выводом: замечаний нет или требуются исправления.

Код и конфигурацию самостоятельно не исправляй.`,
    `Compare the implementation with requirements, the agreed plan and project rules.

Inspect changes and necessary dependencies using the provided tools and applicable skills. If no specialized tools are provided, use the project source files and available change comparisons.

Check correctness, completeness, compatibility and verification coverage. Separate confirmed defects from assumptions and recommendations.

Report issues in order of significance, affected objects or files, consequences and supporting evidence. Conclude whether corrections are required.

Do not fix code or configuration yourself.`],
  ['release-manager', 'Подготовка поставки', 'Release manager',
    `Подготовь результат к передаче пользователю.

Обнови необходимую документацию и подготовь предусмотренные процессом
артефакты с помощью предоставленных инструментов и применимых навыков.
Если специальных инструментов не предусмотрено, используй файлы
документации и штатные средства сборки и упаковки проекта.

Проверь соответствие документации выполненным изменениям,
состав артефактов и результаты обязательных проверок.

В отчёте укажи состав поставки, порядок установки или использования,
выполненные проверки, известные ограничения и оставшиеся действия.

Коммиты, отправку изменений и публикацию выполняй только
по отдельному поручению.`,
    `Prepare the result for delivery to the user.

Update necessary documentation and prepare process deliverables using the provided tools and applicable skills. If no specialized tools are provided, use documentation files and standard project build and packaging facilities.

Check that documentation matches the completed changes, the deliverables and mandatory verification results.

Report the delivery contents, installation or usage instructions, completed checks, known limitations and remaining actions.

Create commits, push changes or publish only when separately instructed.`],
] as const

/** Initial role instructions; existing project instructions always take precedence. */
export function templateRoleInstructions(language: ProcessTemplateLanguage): Record<string, string> {
  return Object.fromEntries(roles.map(([id, ruName, enName, ru, en]) => [
    id, `${language === 'ru' ? ruName : enName}. ${language === 'ru' ? ru : en}\n`,
  ]))
}

/** Common report instructions; role behavior comes only from the project role file. */
export function stepResultInstructions(outputPath: string, language: ProcessTemplateLanguage): string {
  if (language === 'en') return `Perform the work described in the task requirements and your role instructions. Report the result, checks performed and remaining limitations.

Save one final report to \`${outputPath}/report.md\`.
Save additional documents and working artifacts for this step in the same directory.

Write concisely and proportionately to the task. For a simple task, aim for 150–300 words; do not pad the report. Do not repeat the requirements or include search logs or raw tool output.

If an intended tool is unavailable or fails, do not treat it as absent or automatically switch to editing files. Report the problem; use a workaround only if permitted by project rules.

If a user decision is required, state the blocking question and pause work that depends on the answer.

Do not modify the task state.json, process.json or runs.json, and do not use AICraft task management tools.

In the chat, briefly state the result, report path and blocking questions. Finishing executor work does not mean the step is accepted.`
  return `Выполни работу по постановке и инструкции своей роли. В отчёте укажи результат, выполненные проверки и оставшиеся ограничения.

Сохрани единый итоговый отчёт в \`${outputPath}/report.md\`.
Дополнительные документы и рабочие артефакты этого этапа сохраняй
в том же каталоге.

Пиши кратко и соразмерно задаче. Для простой задачи ориентируйся
на 150–300 слов, не увеличивай отчёт ради объёма. Не пересказывай
постановку, не включай журнал поиска и сырые ответы инструментов.

Если предусмотренный инструмент недоступен или завершился ошибкой,
не считай его отсутствующим и не переходи автоматически к изменению
файлов. Укажи проблему; используй обходной путь только тогда,
когда он разрешён правилами проекта.

Если требуется решение пользователя, укажи блокирующий вопрос
и приостанови зависимую от ответа работу.

Не изменяй state.json, process.json и runs.json задачи
и не используй инструменты управления задачей AICraft.

В чате кратко сообщи результат, путь к отчёту и блокирующие вопросы.
Завершение работы исполнителя не означает приёмку этапа.`
}
