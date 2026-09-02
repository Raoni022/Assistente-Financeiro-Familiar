import { Card, SectionTitle } from '@/components/ui/Card';
import { deadlineLabel, type IsoDate } from '@/lib/dates';
import type { Task } from '@/lib/types';

/**
 * Tarefas em aberto.
 *
 * O card só existe quando há tarefa — ao contrário de contas e gastos, que
 * mostram estado vazio com instrução. Um card permanentemente vazio de tarefas
 * ocuparia espaço para dizer que não há nada a dizer.
 */
export function TasksCard({ tasks, today }: { tasks: Task[]; today: IsoDate }) {
  if (tasks.length === 0) return null;

  return (
    <section>
      <SectionTitle>Tarefas</SectionTitle>
      <Card>
        <ul>
          {tasks.map((task, index) => {
            const overdue = task.dueDate !== null && task.dueDate < today;
            return (
              <li
                key={task.id}
                className={`flex items-start justify-between gap-3 ${
                  index > 0 ? 'mt-3 border-t border-line pt-3' : ''
                }`}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span
                    aria-hidden
                    className={`mt-1.5 text-[10px] leading-none ${overdue ? 'text-negative' : 'text-dim'}`}
                  >
                    {overdue ? '▲' : '○'}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[15px]">{task.title}</p>
                    <p className={`text-[13px] ${overdue ? 'text-negative' : 'text-dim'}`}>
                      {deadlineLabel(task.dueDate, today)}
                      {task.assignee ? ` · ${task.assignee.displayName}` : ''}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
