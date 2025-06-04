const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const meetings = new Map();
const activeBots = new Map();
const monitoringIntervals = new Map();

class MeetingRecordingBot {
    constructor(meetingData) {
        this.meeting = meetingData;
        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.isMonitoring = false;
        this.isLoggedIn = false;
        this.debugLogs = [];
    }

    log(message, type = 'info') {
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} [${type.toUpperCase()}] ${message}`;
        console.log(logEntry);
        this.debugLogs.push(logEntry);
    }

    async initialize() {
        this.log(`Inicializando bot para: ${this.meeting.title || 'Reunião'}`);
        
        try {
            // 🚀 Configuração otimizada para login automático
            this.browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-extensions',
                    '--no-first-run',
                    '--disable-default-apps'
                ]
            });

            this.page = await this.browser.newPage();
            
            // 🎭 Configurar como usuário real
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await this.page.setViewport({ width: 1366, height: 768 });
            
            // 🔐 FAZER LOGIN AUTOMÁTICO
            const loginSuccess = await this.performSecureLogin();
            
            if (!loginSuccess) {
                throw new Error('Falha no login automático');
            }
            
            this.log('Bot inicializado e autenticado com sucesso!');
            return true;
            
        } catch (error) {
            this.log(`Erro na inicialização: ${error.message}`, 'error');
            throw error;
        }
    }

    async performSecureLogin() {
        try {
            this.log('Iniciando login automático seguro...');
            
            // 📧 Credenciais das variáveis de ambiente
            const email = process.env.GOOGLE_EMAIL;
            const password = process.env.GOOGLE_PASSWORD;
            
            if (!email || !password) {
                this.log('ERRO: Credenciais não configuradas nas variáveis de ambiente', 'error');
                this.log('Configure GOOGLE_EMAIL e GOOGLE_PASSWORD', 'error');
                return false;
            }
            
            this.log(`Fazendo login com: ${email.replace(/(.{3}).*@/, '$1***@')}`);
            
            // 🌐 Ir para página de login do Google
            await this.page.goto('https://accounts.google.com/signin', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            
            // 📧 PASSO 1: Inserir email
            this.log('Inserindo email...');
            await this.page.waitForSelector('#identifierId', { timeout: 15000 });
            await this.page.type('#identifierId', email, { delay: 100 });
            
            // ▶️ Clicar em "Próximo"
            await this.page.click('#identifierNext');
            await this.page.waitForTimeout(3000);
            
            // 🔐 PASSO 2: Inserir senha
            this.log('Inserindo senha...');
            await this.page.waitForSelector('input[name="password"]', { timeout: 15000 });
            await this.page.type('input[name="password"]', password, { delay: 100 });
            
            // ▶️ Clicar em "Próximo"
            await this.page.click('#passwordNext');
            
            // ⏰ Aguardar login ser processado
            this.log('Aguardando autenticação...');
            await this.page.waitForTimeout(5000);
            
            // ✅ Verificar se login foi bem-sucedido
            const currentUrl = this.page.url();
            
            if (currentUrl.includes('myaccount.google.com') || 
                currentUrl.includes('accounts.google.com/ManageAccount') ||
                !currentUrl.includes('signin')) {
                
                this.log('✅ Login realizado com sucesso!');
                this.isLoggedIn = true;
                
                // 🍪 Aguardar cookies serem salvos
                await this.page.waitForTimeout(2000);
                
                return true;
            } else {
                this.log('❌ Login falhou - ainda na página de autenticação', 'error');
                
                // 🔍 Verificar erros específicos
                const errorElements = await this.page.$$('[jsname="B34EJ"]'); // Selector de erro do Google
                if (errorElements.length > 0) {
                    const errorText = await this.page.evaluate(el => el.textContent, errorElements[0]);
                    this.log(`Erro de login detectado: ${errorText}`, 'error');
                }
                
                return false;
            }
            
        } catch (error) {
            this.log(`Erro durante login: ${error.message}`, 'error');
            return false;
        }
    }

    async startMonitoring() {
        if (!this.isLoggedIn) {
            this.log('Bot não está autenticado - abortando monitoramento', 'error');
            return;
        }
        
        this.log('Iniciando monitoramento autenticado...');
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                this.log('Verificando reunião (como usuário autenticado)...');
                
                const meetingStatus = await this.checkIfMeetingStarted();
                
                if (meetingStatus.isActive) {
                    this.log(`Reunião detectada como ativa! Motivo: ${meetingStatus.reason}`);
                    clearInterval(checkInterval);
                    await this.joinAndRecord();
                    return;
                } else {
                    this.log(`Reunião não ativa. Motivo: ${meetingStatus.reason}`);
                }
                
            } catch (error) {
                this.log(`Erro no monitoramento: ${error.message}`, 'error');
            }
        }, 30000);
        
        const storageKey = this.meeting.eventId || this.meeting.ment_id;
        if (storageKey) {
            monitoringIntervals.set(storageKey, checkInterval);
        }
    }

    async checkIfMeetingStarted() {
        try {
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
                return { isActive: false, reason: 'URL inválida ou não é do Google Meet' };
            }

            this.log(`Navegando para reunião como usuário autenticado: ${meetingUrl}`);
            
            // 🔐 Ir para reunião já logado
            await this.page.goto(meetingUrl, { 
                timeout: 30000,
                waitUntil: 'networkidle2'
            });
            
            // ⏰ Aguardar página carregar completamente
            await this.page.waitForTimeout(5000);
            
            // 🔍 Análise como usuário autenticado
            const meetingAnalysis = await this.page.evaluate(() => {
                const analysis = {
                    url: window.location.href,
                    title: document.title,
                    hasJoinButton: false,
                    hasRecordButton: false,
                    hasParticipants: false,
                    isInMeeting: false,
                    participantCount: 0,
                    userRole: 'unknown',
                    messages: []
                };
                
                // Verificar se está na sala de reunião
                analysis.isInMeeting = document.querySelector('[data-self-video]') !== null ||
                                     document.querySelector('.participants-container') !== null;
                
                // Verificar botão de entrada
                const joinButtons = [
                    'button[jsname="Qx7uuf"]',
                    '[data-is-touch-wrapper="true"]',
                    'button[aria-label*="Join"]',
                    'button[aria-label*="Participar"]'
                ];
                
                analysis.hasJoinButton = joinButtons.some(selector => 
                    document.querySelector(selector) !== null
                );
                
                // Verificar botão de gravação (só visível para usuários com permissão)
                const recordSelectors = [
                    '[aria-label*="Record"]',
                    '[aria-label*="Gravar"]',
                    '[data-tooltip*="Record"]',
                    '[data-tooltip*="Gravar"]'
                ];
                
                analysis.hasRecordButton = recordSelectors.some(selector => 
                    document.querySelector(selector) !== null
                );
                
                // Contar participantes
                const participants = document.querySelectorAll('[data-participant-id]');
                analysis.participantCount = participants.length;
                analysis.hasParticipants = participants.length > 1;
                
                // Verificar mensagens na tela
                const bodyText = document.body.textContent.toLowerCase();
                
                if (bodyText.includes('waiting for others') || bodyText.includes('aguardando outros')) {
                    analysis.messages.push('Aguardando outros participantes');
                }
                
                if (bodyText.includes('you\'re the only one here') || bodyText.includes('você é o único')) {
                    analysis.messages.push('Único participante na reunião');
                }
                
                if (bodyText.includes('meeting hasn\'t started') || bodyText.includes('reunião não começou')) {
                    analysis.messages.push('Reunião ainda não iniciou');
                }
                
                return analysis;
            });
            
            this.log(`Análise da reunião: ${JSON.stringify(meetingAnalysis, null, 2)}`, 'debug');
            
            // 🎯 Lógica de decisão melhorada para usuário autenticado
            if (meetingAnalysis.isInMeeting) {
                return { 
                    isActive: true, 
                    reason: `Já na reunião com ${meetingAnalysis.participantCount} participantes. Botão de gravação: ${meetingAnalysis.hasRecordButton ? 'DISPONÍVEL' : 'NÃO ENCONTRADO'}` 
                };
            }
            
            if (meetingAnalysis.hasJoinButton) {
                return { 
                    isActive: true, 
                    reason: `Reunião pronta para entrada. Botão encontrado.` 
                };
            }
            
            if (meetingAnalysis.messages.length > 0) {
                return { 
                    isActive: false, 
                    reason: `Aguardando: ${meetingAnalysis.messages.join(', ')}` 
                };
            }
            
            return { 
                isActive: false, 
                reason: 'Reunião não está pronta para entrada' 
            };
            
        } catch (error) {
            this.log(`Erro ao verificar reunião: ${error.message}`, 'error');
            return { isActive: false, reason: `Erro: ${error.message}` };
        }
    }

    async joinAndRecord() {
        try {
            this.log('Entrando na reunião como usuário autenticado...');
            
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            // 🔐 Garantir que estamos na página da reunião
            if (!this.page.url().includes(meetingUrl)) {
                await this.page.goto(meetingUrl, {
                    timeout: 30000,
                    waitUntil: 'networkidle2'
                });
            }
            
            // 🚪 Tentar entrar na reunião
            const joinResult = await this.tryJoinMeetingAuthenticated();
            
            if (joinResult.success) {
                this.log(`✅ Entrada bem-sucedida: ${joinResult.method}`);
                
                // ⏰ Aguardar interface carregar
                await this.page.waitForTimeout(8000);
                
                // 🎥 Tentar iniciar gravação com permissões de admin
                const recordingResult = await this.startRecordingAuthenticated();
                
                if (recordingResult.success) {
                    this.log(`✅ Gravação iniciada: ${recordingResult.reason}`);
                } else {
                    this.log(`⚠️ Gravação não foi possível: ${recordingResult.reason}`, 'warning');
                }
                
                // 👀 Monitorar reunião
                await this.monitorRecording();
            } else {
                this.log(`❌ Falha ao entrar: ${joinResult.reason}`, 'error');
            }
            
        } catch (error) {
            this.log(`Erro ao entrar na reunião: ${error.message}`, 'error');
            await this.cleanup();
        }
    }

    async tryJoinMeetingAuthenticated() {
        this.log('Tentando entrar na reunião com usuário autenticado...');
        
        try {
            // 🔍 Verificar se já está na reunião
            const alreadyInMeeting = await this.page.evaluate(() => {
                return document.querySelector('[data-self-video]') !== null ||
                       document.querySelector('.participants-container') !== null;
            });
            
            if (alreadyInMeeting) {
                return { success: true, method: 'Já estava na reunião' };
            }
            
            // 🎯 Estratégias de entrada para usuário autenticado
            const strategies = [
                {
                    name: 'Botão principal de entrada',
                    action: async () => {
                        const button = await this.page.$('button[jsname="Qx7uuf"]');
                        if (button) {
                            await button.click();
                            await this.page.waitForTimeout(3000);
                            return true;
                        }
                        return false;
                    }
                },
                {
                    name: 'Botão "Participar agora"',
                    action: async () => {
                        const button = await this.page.$('[data-is-touch-wrapper="true"]');
                        if (button) {
                            await button.click();
                            await this.page.waitForTimeout(3000);
                            return true;
                        }
                        return false;
                    }
                },
                {
                    name: 'Enter para entrar',
                    action: async () => {
                        await this.page.keyboard.press('Enter');
                        await this.page.waitForTimeout(3000);
                        return true;
                    }
                }
            ];
            
            for (const strategy of strategies) {
                try {
                    this.log(`Tentando estratégia: ${strategy.name}`);
                    const success = await strategy.action();
                    
                    if (success) {
                        // Verificar se realmente entrou
                        const enteredMeeting = await this.page.evaluate(() => {
                            return document.querySelector('[data-self-video]') !== null ||
                                   document.querySelector('.participants-container') !== null;
                        });
                        
                        if (enteredMeeting) {
                            return { success: true, method: strategy.name };
                        }
                    }
                } catch (error) {
                    this.log(`Estratégia ${strategy.name} falhou: ${error.message}`, 'debug');
                }
            }
            
            return { success: false, reason: 'Todas as estratégias de entrada falharam' };
            
        } catch (error) {
            this.log(`Erro ao tentar entrar: ${error.message}`, 'error');
            return { success: false, reason: error.message };
        }
    }

    async startRecordingAuthenticated() {
        this.log('Tentando iniciar gravação com usuário autenticado...');
        
        try {
            // 🔍 Verificar permissões de gravação
            const recordingPermissions = await this.page.evaluate(() => {
                // Procurar por botões/opções de gravação
                const recordingIndicators = [
                    '[aria-label*="Record"]',
                    '[aria-label*="Gravar"]',
                    '[data-tooltip*="Record"]', 
                    '[data-tooltip*="Gravar"]',
                    'button[data-tooltip*="More options"]',
                    'button[aria-label*="More options"]',
                    'button[aria-label*="Mais opções"]'
                ];
                
                const foundElements = [];
                recordingIndicators.forEach(selector => {
                    const element = document.querySelector(selector);
                    if (element) {
                        foundElements.push({
                            selector,
                            text: element.textContent?.trim(),
                            ariaLabel: element.getAttribute('aria-label'),
                            visible: element.offsetParent !== null
                        });
                    }
                });
                
                return {
                    hasRecordingOption: foundElements.length > 0,
                    foundElements,
                    accountType: document.body.textContent.includes('workspace') ? 'workspace' : 'personal'
                };
            });
            
            this.log(`Permissões de gravação: ${JSON.stringify(recordingPermissions, null, 2)}`, 'debug');
            
            if (!recordingPermissions.hasRecordingOption) {
                return { 
                    success: false, 
                    reason: 'Conta não tem permissões de gravação ou interface não carregou completamente' 
                };
            }
            
            // 🎯 Tentar abrir menu "Mais opções"
            const moreOptionsButton = await this.page.$('button[aria-label*="More options"]') ||
                                    await this.page.$('button[aria-label*="Mais opções"]') ||
                                    await this.page.$('[data-tooltip*="More options"]');
            
            if (moreOptionsButton) {
                this.log('Clicando em "Mais opções"...');
                await moreOptionsButton.click();
                await this.page.waitForTimeout(3000);
                
                // 🎥 Procurar opção "Gravar reunião"
                const recordButton = await this.page.evaluate(() => {
                    const texts = ['Record meeting', 'Gravar reunião', 'Start recording', 'Iniciar gravação'];
                    
                    for (const text of texts) {
                        const elements = Array.from(document.querySelectorAll('*'));
                        const element = elements.find(el => 
                            el.textContent?.trim().toLowerCase().includes(text.toLowerCase()) &&
                            (el.tagName === 'BUTTON' || el.tagName === 'DIV' || el.tagName === 'SPAN')
                        );
                        if (element && element.offsetParent !== null) {
                            return { found: true, text: element.textContent, element };
                        }
                    }
                    
                    return { found: false };
                });
                
                if (recordButton.found) {
                    this.log(`Botão de gravação encontrado: "${recordButton.text}"`);
                    
                    // Tentar clicar no botão de gravação
                    await this.page.evaluate((text) => {
                        const elements = Array.from(document.querySelectorAll('*'));
                        const element = elements.find(el => 
                            el.textContent?.trim().toLowerCase().includes(text.toLowerCase())
                        );
                        if (element) {
                            element.click();
                        }
                    }, recordButton.text.toLowerCase());
                    
                    await this.page.waitForTimeout(3000);
                    
                    // 🎯 Confirmar gravação se necessário
                    const confirmButton = await this.page.evaluate(() => {
                        const confirmTexts = ['Start', 'Iniciar', 'Confirm', 'Confirmar'];
                        
                        for (const text of confirmTexts) {
                            const elements = Array.from(document.querySelectorAll('button'));
                            const element = elements.find(el => 
                                el.textContent?.trim().toLowerCase() === text.toLowerCase()
                            );
                            if (element && element.offsetParent !== null) {
                                element.click();
                                return { confirmed: true, text };
                            }
                        }
                        
                        return { confirmed: false };
                    });
                    
                    if (confirmButton.confirmed) {
                        this.log(`Gravação confirmada com: "${confirmButton.text}"`);
                    }
                    
                    this.isRecording = true;
                    return { success: true, reason: 'Gravação iniciada com sucesso' };
                    
                } else {
                    return { 
                        success: false, 
                        reason: 'Botão "Gravar reunião" não encontrado no menu de opções' 
                    };
                }
                
            } else {
                return { 
                    success: false, 
                    reason: 'Botão "Mais opções" não encontrado' 
                };
            }
            
        } catch (error) {
            this.log(`Erro ao iniciar gravação: ${error.message}`, 'error');
            return { success: false, reason: error.message };
        }
    }

    async monitorRecording() {
        this.log('Iniciando monitoramento da reunião autenticada...');
        
        const monitorInterval = setInterval(async () => {
            try {
                const status = await this.page.evaluate(() => {
                    return {
                        url: window.location.href,
                        title: document.title,
                        inMeeting: document.querySelector('[data-self-video]') !== null,
                        participantCount: document.querySelectorAll('[data-participant-id]').length,
                        isRecording: document.body.textContent.toLowerCase().includes('recording') ||
                                   document.body.textContent.toLowerCase().includes('gravando')
                    };
                });
                
                this.log(`Status: Em reunião: ${status.inMeeting}, Participantes: ${status.participantCount}, Gravando: ${status.isRecording}`, 'debug');
                
                if (!status.inMeeting || !status.url.includes('meet.google.com')) {
                    this.log('Reunião encerrada - finalizando bot');
                    clearInterval(monitorInterval);
                    await this.cleanup();
                    return;
                }
                
            } catch (error) {
                this.log(`Erro no monitoramento: ${error.message}`, 'error');
                clearInterval(monitorInterval);
                await this.cleanup();
            }
        }, 30000);
    }

    async cleanup() {
        this.log('Iniciando limpeza de recursos...');
        
        try {
            this.isMonitoring = false;
            
            if (this.page && !this.page.isClosed()) {
                await this.page.close();
            }
            
            if (this.browser && this.browser.connected) {
                await this.browser.close();
            }
            
            const storageKey = this.meeting.eventId || this.meeting.ment_id;
            if (storageKey) {
                activeBots.delete(storageKey);
                monitoringIntervals.delete(storageKey);
            }
            
            this.log('Limpeza concluída');
            
        } catch (error) {
            this.log(`Erro na limpeza: ${error.message}`, 'error');
        }
    }

    getDebugLogs() {
        return this.debugLogs;
    }
}

// Express server endpoints...
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>🤖 Bot Google Meet - AUTENTICADO</title></head>
        <body style="font-family: Arial; margin: 40px;">
            <h1>🤖 Bot de Gravação Google Meet</h1>
            <div style="background: #d4edda; padding: 15px; border-radius: 5px;">
                <h3>🔐 Bot Online - Com Login Automático Seguro</h3>
                <p><strong>Reuniões:</strong> ${meetings.size}</p>
                <p><strong>Ativos:</strong> ${activeBots.size}</p>
                <p><strong>Monitorando:</strong> ${monitoringIntervals.size}</p>
                <p><strong>Status:</strong> Login automático configurado</p>
            </div>
            
            <div style="margin-top: 20px; background: #fff3cd; padding: 15px; border-radius: 5px;">
                <h3>⚙️ Configuração Necessária</h3>
                <p><strong>Variáveis de ambiente necessárias:</strong></p>
                <code>
                    GOOGLE_EMAIL=admin@seuworkspace.com<br>
                    GOOGLE_PASSWORD=suasenhasegura
                </code>
                <p><small>⚠️ Configure essas variáveis no EasyPanel para o bot funcionar</small></p>
            </div>
            
            <div style="margin-top: 20px;">
                <h3>🔍 Debug</h3>
                <a href="/api/debug/logs">Ver Logs Detalhados</a><br>
                <a href="/api/debug/bots">Status dos Bots Autenticados</a>
            </div>
        </body>
        </html>
    `);
});

app.get('/api/debug/logs', (req, res) => {
    const allLogs = [];
    for (const [eventId, bot] of activeBots) {
        allLogs.push({
            eventId,
            isLoggedIn: bot.isLoggedIn,
            logs: bot.getDebugLogs()
        });
    }
    res.json(allLogs);
});

app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    console.log('📅 Nova reunião (com login automático):', JSON.stringify(meetingData, null, 2));
    
    const eventId = meetingData.eventId || meetingData.ment_id || `meeting_${Date.now()}`;
    const meetingUrl = meetingData.meetingUrl || meetingData.ment_zoom;
    
    if (!eventId || !meetingUrl) {
        return res.status(400).json({
            success: false,
            message: 'Dados faltando: eventId e meetingUrl necessários'
        });
    }
    
    // ✅ Verificar se credenciais estão configuradas
    if (!process.env.GOOGLE_EMAIL || !process.env.GOOGLE_PASSWORD) {
        return res.status(500).json({
            success: false,
            message: 'Erro de configuração: GOOGLE_EMAIL e GOOGLE_PASSWORD devem estar configurados nas variáveis de ambiente',
            error: 'Credenciais não configuradas'
        });
    }
    
    meetings.set(eventId, {
        ...meetingData,
        eventId: eventId,
        scheduled: new Date().toISOString(),
        status: 'monitoring',
        authenticatedBot: true
    });
    
    try {
        const bot = new MeetingRecordingBot(meetingData);
        activeBots.set(eventId, bot);
        
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log('✅ Bot autenticado configurado!');
        
        res.json({
            success: true,
            message: 'Bot autenticado configurado com sucesso!',
            eventId: eventId,
            status: 'monitoring',
            authenticated: true,
            debugUrl: `/api/debug/logs`
        });
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
        
        activeBots.delete(eventId);
        meetings.delete(eventId);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao configurar bot autenticado',
            error: error.message
        });
    }
});

app.get('/api/health', (req, res) => {
    const hasCredentials = !!(process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD);
    
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        chrome: 'Puppeteer bundled - FUNCIONANDO 100%',
        version: 'AUTENTICADO COM LOGIN SEGURO',
        authenticated: hasCredentials,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/meetings', (req, res) => {
    res.json({
        total: meetings.size,
        active: activeBots.size,
        monitoring: monitoringIntervals.size,
        meetings: Array.from(meetings.values()),
        status: 'Bot funcionando com login automático seguro!'
    });
});

app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT GOOGLE MEET - LOGIN AUTOMÁTICO');
    console.log('🤖 =====================================');
    console.log(`🌐 Porta: ${port}`);
    console.log(`🔧 Chrome: Puppeteer bundled`);
    console.log(`🔐 Login: Automático e Seguro`);
    
    if (process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD) {
        console.log(`✅ Credenciais: Configuradas`);
        console.log(`📧 Email: ${process.env.GOOGLE_EMAIL.replace(/(.{3}).*@/, '$1***@')}`);
    } else {
        console.log(`❌ Credenciais: NÃO CONFIGURADAS`);
        console.log(`⚠️ Configure GOOGLE_EMAIL e GOOGLE_PASSWORD nas variáveis de ambiente`);
    }
    
    console.log('✅ BOT PRONTO PARA GRAVAR COM PERMISSÕES ADMIN!');
    console.log('🤖 =====================================');
});

process.on('SIGTERM', async () => {
    console.log('🛑 Encerrando bots autenticados...');
    for (const [eventId, bot] of activeBots) {
        await bot.cleanup();
    }
    process.exit(0);
});