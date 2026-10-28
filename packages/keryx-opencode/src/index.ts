export interface KeryxPluginHooks {
  event?: (input: { event: { type: string } }) => Promise<void>;
}

/** OpenCode plugin entry point; reporting to the keryx bus follows in a later issue. */
export const KeryxPlugin = async (): Promise<KeryxPluginHooks> => ({});
