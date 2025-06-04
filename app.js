const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 📊 Armazenamento global
const meetings = new Map();
const activeBots = new Map();
const cookiesData = new Map(); // Cache de cookies

class MeetingRecordingBot {
    constructor(meetingData, botId) {
        this.meeting = meetingData;
        this.botId = botId; // ID único para cada bot
        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.isMonitoring = false;
        this.isLoggedIn = false;
        this.debugLogs = [];
    }

    log(message, type = 'info') {
        const timestamp = new Date().toISOString();
        const logEntry = `[BOT-${this.botId}] ${timestamp} [${type.toUpperCase()}] ${message}`;
        console.log(logEntry);
        this.debugLogs.push(logEntry);
    }

    async initialize() {
        this.log(`Inicializando bot para: ${this.meeting.title || 'Reunião'}`);
        
        try {
            this.browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-blink-features=AutomationControlled'
                ]
            });

            this.page = await this.browser.newPage();
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await this.page.setViewport({ width: 1366, height: 768 });
            
            // 🍪 Carregar cookies
            const cookiesLoaded = await this.loadCookies();
            
            if (cookiesLoaded) {
                this.log('✅ Cookies carregados - bot autenticado!');
                this.isLoggedIn = true;
                return true;
            } else {
                throw new Error('Cookies não configurados - acesse /setup');
            }
            
        } catch (error) {
            this.log(`Erro na inicialização: ${error.message}`, 'error');
            throw error;
        }
    }

    async loadCookies() {
        try {
            // 1️⃣ Tentar carregar cookies do cache
            if (cookiesData.has('google_cookies')) {
                this.log('Carregando cookies do cache...');
                const cookies = cookiesData.get('google_cookies');
                return await this.applyCookies(cookies);
            }
            
            // 2️⃣ Tentar carregar cookies das variáveis de ambiente
            if (process.env.GOOGLE_COOKIES) {
                this.log('Carregando cookies das variáveis de ambiente...');
                const cookies = JSON.parse(process.env.GOOGLE_COOKIES);
                cookiesData.set('google_cookies', cookies); // Salvar no cache
                return await this.applyCookies(cookies);
            }
            
            // 3️⃣ Tentar carregar cookies de arquivo
            const cookiesPath = path.join(__dirname, 'cookies.json');
            if (fs.existsSync(cookiesPath)) {
                this.log('Carregando cookies do arquivo...');
                const cookiesFile = fs.readFileSync(cookiesPath, 'utf8');
                const cookies = JSON.parse(cookiesFile);
                cookiesData.set('google_cookies', cookies); // Salvar no cache
                return await this.applyCookies(cookies);
            }
            
            this.log('Nenhum cookie encontrado', 'error');
            return false;
            
        } catch (error) {
            this.log(`Erro ao carregar cookies: ${error.message}`, 'error');
            return false;
        }
    }

    async applyCookies(cookies) {
        try {
            if (!cookies || cookies.length === 0) {
                return false;
            }
            
            this.log(`Aplicando ${cookies.length} cookies...`);
            
            // Ir para Google primeiro
            await this.page.goto('https://accounts.google.com', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            
            // Aplicar cookies
            await this.page.setCookie(...cookies);
            
            // Testar se funcionam
            await this.page.goto('https://myaccount.google.com', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            
            const isLoggedIn = await this.page.evaluate(() => {
                return !document.body.textContent.includes('Sign in') &&
                       !document.body.textContent.includes('Fazer login');
            });
            
            if (isLoggedIn) {
                this.log('✅ Cookies válidos - autenticação bem-sucedida!');
                return true;
            } else {
                this.log('❌ Cookies expirados ou inválidos');
                return false;
            }
            
        } catch (error) {
            this.log(`Erro ao aplicar cookies: ${error.message}`, 'error');
            return false;
        }
    }

    async startMonitoring() {
        if (!this.isLoggedIn) {
            this.log('Bot não está autenticado - abortando', 'error');
            return;
        }
        
        this.log('Iniciando monitoramento da reunião...');
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                this.log('Verificando se reunião está ativa...');
                const meetingStatus = await this.checkMeeting();
                
                if (meetingStatus.shouldJoin) {
                    this.log(`Reunião ativa! Entrando: ${meetingStatus.reason}`);
                    clearInterval(checkInterval);
                    await this.joinAndRecord();
                    return;
                } else {
                    this.log(`Aguardando: ${meetingStatus.reason}`);
                }
                
            } catch (error) {
                this.log(`Erro no monitoramento: ${error.message}`, 'error');
            }
        }, 30000); // Verificar a cada 30 segundos
    }

    async checkMeeting() {
        try {
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
                return { shouldJoin: false, reason: 'URL inválida' };
            }

            this.log(`Verificando: ${meetingUrl}`);
            
            await this.page.goto(meetingUrl, { 
                timeout: 30000,
                waitUntil: 'networkidle2'
            });
            
            await this.page.waitForTimeout(3000);
            
            const analysis = await this.page.evaluate(() => {
                const result = {
                    hasJoinButton: false,
                    isInMeeting: false,
                    participantCount: 0,
                    waitingMessages: []
                };
                
                // Verificar se já está na reunião
                result.isInMeeting = document.querySelector('[data-self-video]') !== null;
                
                // Verificar botão de entrada
                const joinButtons = [
                    'button[jsname="Qx7uuf"]',
                    '[data-is-touch-wrapper="true"]'
                ];
                
                result.hasJoinButton = joinButtons.some(selector => 
                    document.querySelector(selector) !== null
                );
                
                // Contar participantes
                result.participantCount = document.querySelectorAll('[data-participant-id]').length;
                
                // Verificar mensagens
                const bodyText = document.body.textContent.toLowerCase();
                if (bodyText.includes('waiting') || bodyText.includes('aguardando')) {
                    result.waitingMessages.push('Aguardando outros participantes');
                }
                
                return result;
            });
            
            // Lógica de decisão
            if (analysis.isInMeeting) {
                return { shouldJoin: true, reason: `Já na reunião com ${analysis.participantCount} participantes` };
            }
            
            if (analysis.hasJoinButton && analysis.participantCount > 0) {
                return { shouldJoin: true, reason: `Reunião com ${analysis.participantCount} participantes` };
            }
            
            if (analysis.hasJoinButton) {
                return { shouldJoin: true, reason: 'Reunião disponível para entrada' };
            }
            
            return { shouldJoin: false, reason: 'Reunião ainda não iniciou' };
            
        } catch (error) {
            this.log(`Erro ao verificar reunião: ${error.message}`, 'error');
            return { shouldJoin: false, reason: `Erro: ${error.message}` };
        }
    }

    async joinAndRecord() {
        try {
            this.log('Entrando na reunião...');
            
            // Tentar entrar
            const joined = await this.tryJoin();
            
            if (joined) {
                this.log('✅ Entrada bem-sucedida!');
                await this.page.waitForTimeout(5000);
                
                // Tentar iniciar gravação
                await this.startRecording();
                
                // Monitorar até o fim
                await this.monitorUntilEnd();
            } else {
                this.log('❌ Falha ao entrar na reunião', 'error');
            }
            
        } catch (error) {
            this.log(`Erro ao entrar na reunião: ${error.message}`, 'error');
            await this.cleanup();
        }
    }

    async tryJoin() {
        const strategies = [
            {
                name: 'Botão principal',
                action: async () => {
                    const button = await this.page.$('button[jsname="Qx7uuf"]');
                    if (button) {
                        await button.click();
                        return true;
                    }
                    return false;
                }
            },
            {
                name: 'Enter key',
                action: async () => {
                    await this.page.keyboard.press('Enter');
                    return true;
                }
            }
        ];
        
        for (const strategy of strategies) {
            try {
                this.log(`Tentando: ${strategy.name}`);
                await strategy.action();
                await this.page.waitForTimeout(3000);
                
                // Verificar se entrou
                const inMeeting = await this.page.evaluate(() => {
                    return document.querySelector('[data-self-video]') !== null;
                });
                
                if (inMeeting) {
                    return true;
                }
            } catch (error) {
                this.log(`${strategy.name} falhou: ${error.message}`);
            }
        }
        
        return false;
    }

    async startRecording() {
        this.log('Tentando iniciar gravação...');
        
        try {
            await this.page.waitForTimeout(5000);
            
            // Procurar menu "Mais opções"
            const moreOptions = await this.page.$('button[aria-label*="More options"]') ||
                              await this.page.$('button[aria-label*="Mais opções"]');
            
            if (moreOptions) {
                this.log('Abrindo menu de opções...');
                await moreOptions.click();
                await this.page.waitForTimeout(2000);
                
                // Procurar opção de gravação
                const recordOption = await this.page.evaluate(() => {
                    const texts = ['Record meeting', 'Gravar reunião', 'Start recording'];
                    
                    for (const text of texts) {
                        const elements = Array.from(document.querySelectorAll('*'));
                        const element = elements.find(el => 
                            el.textContent?.includes(text)
                        );
                        if (element) {
                            element.click();
                            return true;
                        }
                    }
                    return false;
                });
                
                if (recordOption) {
                    this.log('✅ Gravação iniciada!');
                    this.isRecording = true;
                    
                    // Confirmar se necessário
                    await this.page.waitForTimeout(2000);
                    const confirmButton = await this.page.$('button:contains("Start")') ||
                                        await this.page.$('button:contains("Iniciar")');
                    if (confirmButton) {
                        await confirmButton.click();
                        this.log('Gravação confirmada');
                    }
                } else {
                    this.log('⚠️ Opção de gravação não encontrada');
                }
            } else {
                this.log('⚠️ Menu "Mais opções" não encontrado');
            }
            
        } catch (error) {
            this.log(`Erro ao iniciar gravação: ${error.message}`, 'error');
        }
    }

    async monitorUntilEnd() {
        this.log('Monitorando reunião até o fim...');
        
        const checkInterval = setInterval(async () => {
            try {
                const inMeeting = await this.page.evaluate(() => {
                    return document.querySelector('[data-self-video]') !== null &&
                           window.location.href.includes('meet.google.com');
                });
                
                if (!inMeeting) {
                    this.log('📞 Reunião encerrada');
                    clearInterval(checkInterval);
                    await this.cleanup();
                    return;
                }
                
                this.log('👥 Ainda na reunião...');
                
            } catch (error) {
                this.log(`Erro no monitoramento: ${error.message}`, 'error');
                clearInterval(checkInterval);
                await this.cleanup();
            }
        }, 30000);
    }

    async cleanup() {
        this.log('Finalizando bot...');
        
        try {
            this.isMonitoring = false;
            
            if (this.page && !this.page.isClosed()) {
                await this.page.close();
            }
            
            if (this.browser && this.browser.connected) {
                await this.browser.close();
            }
            
            // Remover da lista de bots ativos
            activeBots.delete(this.botId);
            
            this.log('✅ Cleanup concluído');
            
        } catch (error) {
            this.log(`Erro no cleanup: ${error.message}`, 'error');
        }
    }

    getDebugLogs() {
        return this.debugLogs;
    }
}

// 🌐 ENDPOINTS EXPRESS

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>🤖 Bot Google Meet - Multi Reunião</title></head>
        <body style="font-family: Arial; margin: 40px;">
            <h1>🤖 Bot de Gravação Google Meet</h1>
            <div style="background: #d4edda; padding: 15px; border-radius: 5px;">
                <h3>✅ Bot Online - Versão Cookies</h3>
                <p><strong>Reuniões Agendadas:</strong> ${meetings.size}</p>
                <p><strong>Bots Ativos:</strong> ${activeBots.size}</p>
                <p><strong>Sistema:</strong> Multi-reunião simultânea</p>
            </div>
            
            <div style="margin-top: 20px;">
                <h3>🔧 Configuração</h3>
                <p><a href="/setup" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                   🍪 Configurar Cookies
                </a></p>
                <p><a href="/api/debug/logs" style="background: #17a2b8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                   📊 Ver Logs
                </a></p>
            </div>
        </body>
        </html>
    `);
});

// 🍪 Página de setup de cookies
app.get('/setup', (req, res) => {
    res.send(`
        <html>
        <head><title>🍪 Setup Cookies</title></head>
        <body style="font-family: Arial; margin: 40px;">
            <h1>🍪 Configuração de Cookies</h1>
            
            <div style="background: #fff3cd; padding: 20px; border-radius: 5px; margin-bottom: 20px;">
                <h3>📋 Instruções:</h3>
                <ol>
                    <li><strong>Abra</strong> <a href="https://accounts.google.com" target="_blank">accounts.google.com</a> em nova aba</li>
                    <li><strong>Faça login</strong> com mentorias@universoextremo.com.br</li>
                    <li><strong>Abra DevTools</strong> (F12)</li>
                    <li><strong>Console tab</strong></li>
                    <li><strong>Cole e execute:</strong></li>
                </ol>
                
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; font-family: monospace; margin: 10px 0;">
copy(JSON.stringify(document.cookie.split('; ').map(c => {
    const [name, value] = c.split('=');
    return {
        name: name,
        value: value,
        domain: '.google.com',
        path: '/',
        httpOnly: false,
        secure: true
    };
})))
                </div>
                
                <p>6. <strong>Cole o resultado</strong> na caixa abaixo:</p>
            </div>
            
            <form action="/save-cookies" method="post">
                <textarea name="cookies" placeholder="Cole os cookies aqui..." 
                         style="width: 100%; height: 200px; margin: 10px 0;"></textarea>
                <br>
                <button type="submit" style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 5px;">
                    💾 Salvar Cookies
                </button>
            </form>
        </body>
        </html>
    `);
});

// 💾 Salvar cookies
app.post('/save-cookies', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const cookies = JSON.parse(req.body.cookies);
        
        // Salvar no cache
        cookiesData.set('google_cookies', cookies);
        
        // Salvar em arquivo
        fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
        
        res.send(`
            <div style="font-family: Arial; margin: 40px;">
                <h2 style="color: green;">✅ Cookies salvos com sucesso!</h2>
                <p>O bot agora pode se autenticar automaticamente.</p>
                <a href="/">← Voltar ao painel</a>
            </div>
        `);
        
    } catch (error) {
        res.send(`
            <div style="font-family: Arial; margin: 40px;">
                <h2 style="color: red;">❌ Erro ao salvar cookies</h2>
                <p>${error.message}</p>
                <a href="/setup">← Tentar novamente</a>
            </div>
        `);
    }
});

// 🚀 Endpoint principal - compatível com n8n
app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    console.log('📅 Nova reunião agendada:', JSON.stringify(meetingData, null, 2));
    
    const eventId = meetingData.eventId || meetingData.ment_id || `meeting_${Date.now()}`;
    const meetingUrl = meetingData.meetingUrl || meetingData.ment_zoom;
    
    if (!eventId || !meetingUrl) {
        return res.status(400).json({
            success: false,
            message: 'EventID e meetingUrl são obrigatórios'
        });
    }
    
    meetings.set(eventId, {
        ...meetingData,
        eventId: eventId,
        scheduled: new Date().toISOString(),
        status: 'scheduled'
    });
    
    try {
        // 🤖 Criar bot único para esta reunião
        const botId = `bot_${eventId}_${Date.now()}`;
        const bot = new MeetingRecordingBot(meetingData, botId);
        
        activeBots.set(botId, bot);
        
        // 🚀 Inicializar e começar monitoramento
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log(`✅ Bot ${botId} configurado para reunião ${eventId}`);
        
        res.json({
            success: true,
            message: 'Bot configurado com sucesso!',
            eventId: eventId,
            botId: botId,
            status: 'monitoring',
            activeBots: activeBots.size
        });
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
        
        meetings.delete(eventId);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao configurar bot',
            error: error.message
        });
    }
});

// 📊 Status
app.get('/api/status', (req, res) => {
    res.json({
        meetings: meetings.size,
        activeBots: activeBots.size,
        hasCookies: cookiesData.has('google_cookies'),
        uptime: process.uptime(),
        botList: Array.from(activeBots.keys())
    });
});

// 📋 Logs de debug
app.get('/api/debug/logs', (req, res) => {
    const allLogs = [];
    for (const [botId, bot] of activeBots) {
        allLogs.push({
            botId,
            logs: bot.getDebugLogs()
        });
    }
    res.json(allLogs);
});

// 🔧 Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        version: 'COOKIES + MULTI-REUNIÃO',
        hasCookies: cookiesData.has('google_cookies') || fs.existsSync(path.join(__dirname, 'cookies.json')),
        activeBots: activeBots.size,
        timestamp: new Date().toISOString()
    });
});

app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT GOOGLE MEET - VERSÃO FINAL');
    console.log('🤖 =====================================');
    console.log(`🌐 Porta: ${port}`);
    console.log(`🍪 Autenticação: Cookies`);
    console.log(`🤖 Sistema: Multi-reunião simultânea`);
    console.log(`🔧 Setup: http://localhost:${port}/setup`);
    console.log('✅ BOT PRONTO PARA MÚLTIPLAS GRAVAÇÕES!');
    console.log('🤖 =====================================');
});

process.on('SIGTERM', async () => {
    console.log('🛑 Encerrando todos os bots...');
    for (const [botId, bot] of activeBots) {
        await bot.cleanup();
    }
    process.exit(0);
});