import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./Dialog";
import { MemoryState } from "./MemoryControls";
import {
  memoryApi,
  memoryErrorKey,
  type MemoryCursor,
  type MemoryPage as MemoryResults,
  type MemoryQuery,
  type MemoryRecord,
} from "./memoryApi";
import type { MemoryController } from "./useMemory";
import { loadMemoryAsset } from "./assetQueue";
import { memoryEventKey, memoryUserLabel } from "./memoryPresentation";

function SavedImage({
  record,
  thumbnail,
  date,
}: {
  record: MemoryRecord;
  thumbnail: boolean;
  date: string;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!thumbnail);
  useEffect(() => {
    if (!thumbnail || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [thumbnail]);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const abort = new AbortController();
    setUrl(null);
    setFailed(false);
    if (
      visible &&
      (thumbnail
        ? record.hasThumbnail
        : record.hasVisual || record.hasThumbnail)
    ) {
      void loadMemoryAsset(
        record.id,
        thumbnail || !record.hasVisual,
        abort.signal,
      ).then(
        (value) => {
          if (!cancelled) {
            objectUrl = URL.createObjectURL(
              new Blob([value], { type: "image/jpeg" }),
            );
            setUrl(objectUrl);
          }
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    }
    return () => {
      cancelled = true;
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [record.id, record.hasVisual, record.hasThumbnail, thumbnail, visible]);
  const hasAsset = thumbnail
    ? record.hasThumbnail
    : record.hasVisual || record.hasThumbnail;
  return (
    <div ref={ref} className={thumbnail ? "memory-thumbnail" : "memory-image"}>
      {url ? (
        <img
          src={url}
          alt={t("memory.imageAlt", { date })}
          loading="lazy"
          onError={() => {
            if (url) URL.revokeObjectURL(url);
            setFailed(true);
            setUrl(null);
          }}
        />
      ) : (
        <span>
          {!hasAsset
            ? t("memory.metadataOnly")
            : failed
              ? t("memory.imageUnavailable")
              : t("memory.imageLoading")}
        </span>
      )}
    </div>
  );
}

export function MemoryPage({
  memory,
  onEnable,
  onRemember,
  canRemember,
}: {
  memory: MemoryController;
  onEnable: () => void;
  onRemember: () => void;
  canRemember: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [results, setResults] = useState<MemoryResults>({ items: [] });
  const [query, setQuery] = useState<MemoryQuery>({ limit: 24 });
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const [confirmation, setConfirmation] = useState<"clear" | "delete" | null>(
    null,
  );
  const [cursors, setCursors] = useState<(MemoryCursor | undefined)[]>([]);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const value = await memoryApi.search(query);
      if (request.current === id) setResults(value);
    } catch (cause) {
      if (request.current === id) setError(memoryErrorKey(cause));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    void load();
    return () => {
      ++request.current;
    };
  }, [load, memory.revision, memory.status?.savedCount]);
  const date = (time: number) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(time);
  const dateGroup = (time: number) => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return time >= now.getTime()
      ? t("common.today")
      : time >= yesterday.getTime()
        ? t("common.yesterday")
        : new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(
            time,
          );
  };
  async function open(record: MemoryRecord) {
    const result = await memory.run(() => memoryApi.get(record.id));
    if (result) setSelected(result.value);
  }
  function search() {
    setCursors([]);
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : undefined;
    const start = from ? new Date(`${from}T00:00:00`).getTime() : undefined;
    if (start !== undefined && end !== undefined && start > end) {
      setError("memory.MemoryInvalidInput");
      return;
    }
    setQuery({
      text: text.trim() || undefined,
      from: start,
      to: end,
      bookmarkedOnly,
      limit: 24,
    });
  }
  const status = memory.status;
  return (
    <section aria-labelledby="memory-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("app.memory")}</p>
          <h1 id="memory-title">{t("memory.title")}</h1>
          <p>{t("memory.intro")}</p>
        </div>
        <button
          className="primary"
          disabled={!canRemember || memory.busy}
          onClick={onRemember}
        >
          {t("home.remember")}
        </button>
      </div>
      {!canRemember && <p className="help-text">{t("home.rememberHint")}</p>}
      <MemoryState memory={memory} onEnable={onEnable} />
      {status && (
        <div className="storage-summary">
          <span>{t("memory.savedCount", { count: status.savedCount })}</span>
          <span>
            {t("memory.storage", {
              size: new Intl.NumberFormat(i18n.language, {
                maximumFractionDigits: 1,
              }).format(status.storageBytes / 1048576),
            })}
          </span>
          <span>{t("memory.localOnly")}</span>
        </div>
      )}
      {(memory.error || error) && (
        <div className="error" role="alert">
          <p>{t(error ?? memory.error!)}</p>
          <button
            onClick={() => {
              void memory.refresh();
              void load();
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
      <form
        className="memory-search"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <label className="search-field">
          {t("memory.search")}
          <input
            type="search"
            maxLength={200}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="filter-row">
          <label>
            {t("memory.dateFrom")}
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            {t("memory.dateTo")}
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={bookmarkedOnly}
              onChange={(event) => setBookmarkedOnly(event.target.checked)}
            />
            {t("memory.bookmarksOnly")}
          </label>
          <button disabled={loading}>{t("memory.searchButton")}</button>
        </div>
        <p className="help-text">{t("memory.searchHint")}</p>
      </form>
      {loading ? (
        <p role="status">{t("common.loading")}</p>
      ) : !error && results.items.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true" className="empty-symbol">
            ◷
          </span>
          <h2>
            {t(
              query.text || query.from || query.to || query.bookmarkedOnly
                ? "memory.searchEmpty"
                : "memory.empty",
            )}
          </h2>
          <p>{t("memory.emptyDescription")}</p>
          {(query.text || query.from || query.to || query.bookmarkedOnly) && (
            <button
              onClick={() => {
                setText("");
                setFrom("");
                setTo("");
                setBookmarkedOnly(false);
                setCursors([]);
                setQuery({ limit: 24 });
              }}
            >
              {t("memory.reset")}
            </button>
          )}
        </div>
      ) : (
        <div className="memory-timeline" aria-label={t("memory.history")}>
          {results.items.map((record, index) => (
            <div key={record.id}>
              {(index === 0 ||
                dateGroup(record.observedAt) !==
                  dateGroup(results.items[index - 1].observedAt)) && (
                <h2 className="timeline-day">{dateGroup(record.observedAt)}</h2>
              )}
              <article className="memory-card">
                <button
                  className="memory-open"
                  onClick={() => void open(record)}
                  disabled={memory.busy}
                  aria-label={`${t("memory.open")}: ${date(record.observedAt)}`}
                >
                  <SavedImage
                    record={record}
                    thumbnail
                    date={date(record.observedAt)}
                  />
                  <div>
                    <h3>
                      {memoryUserLabel(record) || t(memoryEventKey(record))}
                    </h3>
                    <time dateTime={new Date(record.observedAt).toISOString()}>
                      {date(record.observedAt)}
                    </time>
                    {record.sourceApplication && (
                      <p>{record.sourceApplication}</p>
                    )}
                    <p className="memory-label">{t(memoryEventKey(record))}</p>
                  </div>
                </button>
                <button
                  className={record.bookmarked ? "bookmark active" : "bookmark"}
                  aria-label={t(
                    record.bookmarked
                      ? "memory.removeBookmark"
                      : "memory.bookmark",
                  )}
                  aria-pressed={record.bookmarked}
                  disabled={memory.busy}
                  onClick={() =>
                    void memory.run(() =>
                      memoryApi.bookmark(record.id, !record.bookmarked),
                    )
                  }
                >
                  {record.bookmarked ? "★" : "☆"}
                </button>
              </article>
            </div>
          ))}
        </div>
      )}
      <div className="controls page-controls">
        {cursors.length > 0 && (
          <button
            disabled={loading}
            onClick={() => {
              const history = [...cursors];
              const previous = history.pop();
              setCursors(history);
              setQuery({ ...query, cursor: previous });
            }}
          >
            {t("common.back")}
          </button>
        )}
        {results.nextCursor && (
          <button
            disabled={loading}
            onClick={() => {
              setCursors([...cursors, query.cursor]);
              setQuery({ ...query, cursor: results.nextCursor! });
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            {t("memory.loadMore")}
          </button>
        )}
        <button
          className="danger-link"
          disabled={memory.busy || !status?.savedCount}
          onClick={() => setConfirmation("clear")}
        >
          {t("memory.clear")}
        </button>
      </div>
      <p className="help-text">{t("memory.privacy")}</p>
      {selected && !confirmation && (
        <Dialog
          title={t("memory.details")}
          onClose={() => setSelected(null)}
          busy={memory.busy}
        >
          <SavedImage
            record={selected}
            thumbnail={false}
            date={date(selected.observedAt)}
          />
          <h3>{memoryUserLabel(selected) || t(memoryEventKey(selected))}</h3>
          {memoryUserLabel(selected) && (
            <p className="help-text">{t("memory.labelSource")}</p>
          )}
          <p>
            {t(
              selected.summarySource === "system_metadata"
                ? "memory.automaticProvenance"
                : "memory.provenance",
            )}
          </p>
          {selected.expiresAt && !selected.bookmarked && (
            <p className="help-text">
              {t("memory.expires", { date: date(selected.expiresAt) })}
            </p>
          )}
          <p>
            <time dateTime={new Date(selected.observedAt).toISOString()}>
              {date(selected.observedAt)}
            </time>
          </p>
          {selected.sourceApplication && (
            <p>
              {t("memory.source")}: {selected.sourceApplication}
            </p>
          )}
          <p className="help-text">{t("memory.bookmarkNote")}</p>
          {memory.error && (
            <p className="error" role="alert">
              {t(memory.error)}
            </p>
          )}
          <div className="controls">
            <button
              aria-pressed={selected.bookmarked}
              disabled={memory.busy}
              onClick={async () => {
                const result = await memory.run(() =>
                  memoryApi.bookmark(selected.id, !selected.bookmarked),
                );
                if (result) setSelected(result.value);
              }}
            >
              {t(
                selected.bookmarked
                  ? "memory.removeBookmark"
                  : "memory.bookmark",
              )}
            </button>
            <button
              className="danger"
              disabled={memory.busy}
              onClick={() => setConfirmation("delete")}
            >
              {t("common.delete")}
            </button>
          </div>
        </Dialog>
      )}
      {confirmation && (
        <Dialog
          title={t(
            confirmation === "clear"
              ? "memory.clearTitle"
              : "memory.deleteTitle",
          )}
          onClose={() => setConfirmation(null)}
          busy={memory.busy}
        >
          <p>
            {t(
              confirmation === "clear"
                ? "memory.clearDescription"
                : "memory.deleteDescription",
            )}
          </p>
          {memory.error && (
            <p role="alert" className="error">
              {t(memory.error)}
            </p>
          )}
          <div className="controls">
            <button
              disabled={memory.busy}
              onClick={() => setConfirmation(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="danger"
              disabled={memory.busy}
              onClick={async () => {
                const result = await memory.run(() =>
                  confirmation === "clear"
                    ? memoryApi.clear()
                    : memoryApi.delete(selected!.id),
                );
                if (result) {
                  setConfirmation(null);
                  setSelected(null);
                  setCursors([]);
                  setQuery({ ...query, cursor: undefined });
                }
              }}
            >
              {t(
                confirmation === "clear"
                  ? "memory.clearConfirm"
                  : "common.delete",
              )}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
