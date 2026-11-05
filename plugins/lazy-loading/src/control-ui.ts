import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

/**
 * Placeholder page. The real "Lazy Loading" tab (overview, agents, catalog) is
 * built on top of the stable feature contract by the UI work (U-01..U-08).
 */
export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({ id: "lazy-loading", label: "Lazy Loading", page: { id: "lazy-loading" }, icon: "fileText" });
    host.ui.registerPage({
      id: "lazy-loading",
      label: "Lazy Loading",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const section = document.createElement("section");
        section.className = "lazy-loading-page";
        const heading = document.createElement("h1");
        heading.textContent = "Lazy Loading";
        const output = document.createElement("output");
        output.setAttribute("aria-live", "polite");
        output.textContent = "Loading...";
        section.append(heading, output);
        container.append(section);
        feature
          .invoke("status", {})
          .then((status) => {
            if (!context.signal.aborted) output.textContent = `Plugin ready (v${status.pluginVersion})`;
          })
          .catch((error: unknown) => {
            if (!context.signal.aborted) output.textContent = String(error);
          });
        return { dispose: () => section.remove() };
      },
    });
  },
});
