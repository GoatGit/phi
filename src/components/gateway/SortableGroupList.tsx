import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function SortableItem({
  id,
  label,
  disabled,
  children,
}: {
  id: string;
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-md border border-border p-3",
        isDragging && "opacity-60",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        size="icon-compact"
        variant="ghost"
        className="shrink-0 touch-none cursor-grab active:cursor-grabbing"
        disabled={disabled}
        {...attributes}
        {...listeners}
        aria-label={t("gateway.groups.dragItem", { name: label })}
        title={t("gateway.groups.dragHint")}
      >
        <GripVertical data-icon="inline-start" aria-hidden />
      </Button>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** Sort only the local draft; saving the dialog commits the final order. */
export function SortableGroupList<T extends { id: string }>({
  items,
  label,
  itemLabel,
  disabled,
  onReorder,
  children,
}: {
  items: T[];
  label: string;
  itemLabel: (item: T) => string;
  disabled: boolean;
  onReorder: (items: T[]) => void;
  children: (item: T, index: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        screenReaderInstructions: { draggable: t("gateway.groups.dragHint") },
      }}
      onDragEnd={({ active, over }) => {
        if (disabled || !over || active.id === over.id) return;
        const from = items.findIndex((item) => item.id === active.id);
        const to = items.findIndex((item) => item.id === over.id);
        if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
      }}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <ol aria-label={label} className="flex min-w-0 flex-col gap-2">
          {items.map((item, index) => (
            <SortableItem
              key={item.id}
              id={item.id}
              label={itemLabel(item)}
              disabled={disabled}
            >
              {children(item, index)}
            </SortableItem>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
