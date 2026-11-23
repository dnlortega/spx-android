module.exports = {
    content: [
        'app/src/main/assets/index.html',
        'app/src/main/assets/js/*.js'
    ],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['JetBrains Mono', 'monospace']
            },
            colors: {
                shopee: {
                    DEFAULT: '#EE4D2D',
                    dark: '#D73211',
                    light: '#FFF0ED',
                    hover: '#E04324'
                }
            },
            boxShadow: {
                'shadcn-xs': '0 1px 2px 0 rgba(0, 0, 0, 0.04)',
                'shadcn-sm': '0 1px 3px 0 rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.04)',
                'shadcn-md': '0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05)',
                'shadcn-xl': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.08)'
            }
        }
    }
};
