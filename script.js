// Theme management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('theme-toggle');
        this.themeIcon = document.getElementById('theme-icon');
        this.currentTheme = this.getStoredTheme() || this.getSystemTheme();
        
        this.init();
    }

    init() {
        this.applyTheme(this.currentTheme);
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
        
        // Listen for system theme changes
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (this.getStoredTheme() === null) {
                    this.applyTheme(e.matches ? 'dark' : 'light');
                }
            });
        }
    }

    getStoredTheme() {
        return localStorage.getItem('theme');
    }

    getSystemTheme() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        this.updateIcon(theme);
        localStorage.setItem('theme', theme);
        this.currentTheme = theme;
    }

    updateIcon(theme) {
        if (theme === 'dark') {
            this.themeIcon.textContent = '☀️';
        } else {
            this.themeIcon.textContent = '🌙';
        }
    }

    toggleTheme() {
        const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        this.applyTheme(newTheme);
    }
}

// Image expander functionality
class ImageExpander {
    constructor() {
        this.modal = document.getElementById('image-modal');
        this.modalImage = document.getElementById('modal-image');
        this.closeBtn = document.querySelector('.close-modal');
        
        this.init();
    }

    init() {
        // Add click event to expandable images
        document.querySelectorAll('.expandable-image').forEach(img => {
            img.addEventListener('click', (e) => this.openModal(e));
        });

        // Close modal when clicking the close button
        this.closeBtn.addEventListener('click', () => this.closeModal());

        // Close modal when clicking outside the image
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });

        // Close modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                this.closeModal();
            }
        });
    }

    openModal(e) {
        e.preventDefault();
        const imgSrc = e.target.getAttribute('data-image-src');
        this.modalImage.src = imgSrc;
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    closeModal() {
        this.modal.classList.remove('show');
        document.body.style.overflow = ''; // Restore scrolling
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme manager
    new ThemeManager();
    
    // Initialize image expander
    new ImageExpander();
    
    // Disable disabled links
    document.querySelectorAll('a[disabled]').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
        });
    });
});
