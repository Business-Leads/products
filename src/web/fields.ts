import type { Field } from "../products/types.js";
import { html } from "./html.js";

export function fieldInput(f: Field, value: string) {
  const common = { name: f.key, id: f.key };
  if (f.type === "textarea") {
    return html`<textarea name="${common.name}" id="${common.id}" ${f.required ? "required" : ""}>${value}</textarea>`;
  }
  if (f.type === "select") {
    return html`<select name="${f.key}" id="${f.key}" ${f.required ? "required" : ""}>
      <option value="">Choose…</option>
      ${(f.options ?? []).map((o) => html`<option ${o === value ? "selected" : ""}>${o}</option>`)}
    </select>`;
  }
  return html`<input type="${f.type}" name="${f.key}" id="${f.key}" value="${value}" ${f.required ? "required" : ""}>`;
}
