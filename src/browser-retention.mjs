import { CollectionContexts } from "./collection-contexts.mjs";
import { createVerifiedChapterWriter } from "./verified-chapter.mjs";

export function retainedBrowserOptions({ store }) {
  return {
    contextPool: new CollectionContexts(),
    onVerified: createVerifiedChapterWriter({ store }),
  };
}
