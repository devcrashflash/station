import { useState } from "react";
import { ArrowLeft, LoaderCircle, RotateCw, SquareKanban } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { normalizeTrelloMarkdown, trelloTicketDraftDescription } from "@/lib/trelloTicket";

export function TrelloTicketWizard({ task, boards, onClose, onLoadTemplates, onConvert }) {
  const [step, setStep] = useState("board");
  const [board, setBoard] = useState(null);
  const [boardData, setBoardData] = useState({ templates: [], lists: [] });
  const [template, setTemplate] = useState(null);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.body || "");
  const [listId, setListId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function loadBoardTemplates(nextBoard) {
    setBoard(nextBoard);
    setTemplate(null);
    setBoardData({ templates: [], lists: [] });
    setListId("");
    setError("");
    setStep("template");
    setIsLoading(true);
    try {
      const result = await onLoadTemplates({
        taskId: task.id,
        boardResourceId: nextBoard.id,
      });
      setBoardData({
        templates: result.templates || [],
        lists: result.lists || [],
      });
    } catch (loadError) {
      setError(loadError?.message || String(loadError));
    } finally {
      setIsLoading(false);
    }
  }

  function chooseTemplate(nextTemplate) {
    setTemplate(nextTemplate);
    setTitle(task.title);
    setDescription(trelloTicketDraftDescription(nextTemplate.description, task.body));
    setListId(boardData.lists[0]?.id || "");
    setError("");
    setStep("details");
  }

  async function submit(event) {
    event.preventDefault();
    if (isSubmitting || !board || !template || !listId || !title.trim()) return;
    setIsSubmitting(true);
    setError("");
    try {
      await onConvert({
        taskId: task.id,
        boardResourceId: board.id,
        templateCardId: template.id,
        listId,
        title,
        description: normalizeTrelloMarkdown(description),
      });
    } catch (submitError) {
      setError(submitError?.message || String(submitError));
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      title="Create Trello ticket"
      onClose={() => !isSubmitting && onClose()}
      contentClassName="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl"
    >
      <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
        <p className="text-sm text-muted-foreground">
          {step === "board" && "Choose the connected board where the ticket should be created."}
          {step === "template" && `Choose a ticket template from ${board?.name}.`}
          {step === "details" && `Review the ticket content before creating it on ${board?.name}.`}
        </p>

        {error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === "board" && (
          <div className="grid gap-2">
            {boards.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex items-center gap-3 rounded-md border bg-card p-3 text-left hover:bg-accent"
                onClick={() => loadBoardTemplates(item)}
              >
                <SquareKanban className="size-5 shrink-0 text-blue-600 dark:text-blue-400" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.url}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {step === "template" && (
          <div className="grid gap-3">
            {isLoading ? (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading templates...
              </p>
            ) : boardData.templates.length === 0 ? (
              <div className="grid gap-3">
                <EmptyState text={error ? "Templates could not be loaded." : "This board has no Trello ticket templates."} />
                <Button type="button" variant="outline" onClick={() => loadBoardTemplates(board)}>
                  <RotateCw className="size-4" />
                  Retry
                </Button>
              </div>
            ) : (
              boardData.templates.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="rounded-md border bg-card p-3 text-left hover:bg-accent"
                  onClick={() => chooseTemplate(item)}
                >
                  <span className="block text-sm font-medium">{item.name}</span>
                </button>
              ))
            )}
            <Button type="button" variant="outline" disabled={isLoading} onClick={() => {
              setStep("board");
              setBoard(null);
              setError("");
            }}>
              <ArrowLeft className="size-4" />
              Back to boards
            </Button>
          </div>
        )}

        {step === "details" && (
          <form className="grid gap-4" onSubmit={submit}>
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input value={title} required onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                className="min-h-48 resize-y"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Destination list</FieldLabel>
              <SelectControl
                value={listId}
                onValueChange={setListId}
                options={boardData.lists.map((list) => ({ value: list.id, label: list.name }))}
                placeholder="Choose a list"
              />
            </Field>
            {boardData.lists.length === 0 && (
              <p className="text-sm text-destructive">This board has no open destination lists.</p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => {
                setStep("template");
                setTemplate(null);
                setError("");
              }}>
                <ArrowLeft className="size-4" />
                Back to templates
              </Button>
              <Button type="submit" disabled={isSubmitting || !title.trim() || !listId}>
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : <SquareKanban className="size-4" />}
                {isSubmitting ? "Creating..." : "Create Trello ticket"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
