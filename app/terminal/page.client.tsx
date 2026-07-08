import { mountPage } from "../../src/web/client/runtime";
import { TerminalPage } from "../../src/web/client/pages/terminal";

export default function mount() {
  return mountPage("terminal", TerminalPage);
}
