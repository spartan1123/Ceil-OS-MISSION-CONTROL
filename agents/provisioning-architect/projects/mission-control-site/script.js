const root = document.documentElement;
const toggle = document.getElementById('themeToggle');
const toast = document.getElementById('toast');
const savedTheme = localStorage.getItem('mission-control-theme');

if (savedTheme) {
  root.setAttribute('data-theme', savedTheme);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1800);
}

toggle?.addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  localStorage.setItem('mission-control-theme', next);
  showToast(`Switched to ${next} mode`);
});

document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast('Prompt copied');
    } catch (error) {
      showToast('Copy failed');
    }
  });
});
