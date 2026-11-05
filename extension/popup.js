const t = document.getElementById("t"), m = document.getElementById("m");
chrome.storage.local.get("token").then(v => { if (v.token) t.placeholder = "saved"; });
document.getElementById("s").onclick = async () => {
  await chrome.storage.local.set({ token: t.value.trim() });
  t.value = ""; t.placeholder = "saved"; m.textContent = "saved";
};
