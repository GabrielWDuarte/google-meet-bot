const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Armazenamento das reuniões e bots ativos
const meetings = new Map();
const activeBots = new Map();
const monitoringIntervals = new Map();

// Configurações do bot
const BOT_CONFIG = {
    email: 'mentorias@universoextremo.com.br',
    headless: true, // True para produção
    monitorInterval: 30000, // 30 segundos
    maxDuration: 2 * 60 * 60 * 1000, // 2 horas máximo
};

// Função para encontrar o executável do Chrome
function getChromeExecutablePath() {
    console.log('🔧 Forçando uso do Chrome bundled do Puppeteer');
    return null; // Sempre usar bundled
}

// Classe do Bot de Gravação
class MeetingRecordingBot {
    constructor(meetingData) {
        this.meeting = meetingData;
        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.participants = 0;
        this.startTime = null;
        this.isMonitoring = false;
    }

    async initialize() {
        console.log(`🤖 Inicializando bot para: ${this.meeting.title || this.meeting.ment_titulo || 'Reunião'}`);
        
        const chromeExecutablePath = getChromeExecutablePath();
        
        const launchOptions = {
            headless: BOT_CONFIG.headless,
            userDataDir: './bot-session',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--disable-features=VizDisplayCompositor',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-web-security',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-default-apps'
            ]
        };

        // Adicionar executablePath apenas se encontrou o Chrome
        if (chromeExecutablePath) {
            launchOptions.executablePath = chromeExecutablePath;
        }

        this.browser = await puppeteer.launch(launchOptions);

        this.page = await this.browser.newPage();
        
        // Configurar permissões
        const context = this.browser.defaultBrowserContext();
        await context.overridePermissions('https://meet.google.com', [
            'microphone', 
            'camera'
        ]);

        await this.page.setViewport({ width: 1366, height: 768 });
        
        // Log do evento usado como ID
        const eventId = this.meeting.eventId || this.meeting.ment_id || 'unknown';
        console.log(`✅ Bot inicializado para evento: ${eventId}`);
    }

    async startMonitoring() {
        const meetingTitle = this.meeting.title || this.meeting.ment_titulo || 'Reunião';
        console.log(`👀 Iniciando monitoramento da reunião: ${meetingTitle}`);
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                const eventId = this.meeting.eventId || this.meeting.ment_id || 'unknown';
                console.log(`🔍 Verificando se reunião ${eventId} iniciou...`);
                
                const hasParticipants = await this.checkIfMeetingStarted();
                
                if (hasParticipants) {
                    console.log(`🎉 Reunião iniciou! Entrando agora...`);
                    clearInterval(checkInterval);
                    const storageKey = this.meeting.eventId || this.meeting.ment_id;
                    if (storageKey) {
                        monitoringIntervals.delete(storageKey);
                    }
                    
                    await this.joinAndRecord();
                    return;
                }
                
                // Verificar se passou do horário limite
                const now = new Date();
                let meetingTime = new Date();
                
                // Tentar diferentes formatos de data
                if (this.meeting.startTime) {
                    meetingTime = new Date(this.meeting.startTime);
                } else if (this.meeting.ment_data && this.meeting.ment_horario) {
                    meetingTime = new Date(`${this.meeting.ment_data}T${this.meeting.ment_horario}:00`);
                }
                
                const timeDiff = now - meetingTime;
                
                if (timeDiff > 30 * 60 * 1000) { // 30 minutos depois
                    console.log(`⏰ Reunião ${eventId} expirou (30min sem iniciar)`);
                    clearInterval(checkInterval);
                    const storageKey = this.meeting.eventId || this.meeting.ment_id;
                    if (storageKey) {
                        monitoringIntervals.delete(storageKey);
                    }
                    await this.cleanup();
                    return;
                }
                
            } catch (error) {
                console.error(`❌ Erro no monitoramento:`, error.message);
            }
        }, BOT_CONFIG.monitorInterval);
        
        const storageKey = this.meeting.eventId || this.meeting.ment_id;
        if (storageKey) {
            monitoringIntervals.set(storageKey, checkInterval);
        }
    }

    async checkIfMeetingStarted() {
        try {
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
                console.log('⚠️ URL da reunião inválida ou não é Google Meet');
                return false;
            }

            await this.page.goto(meetingUrl, { 
                waitUntil: 'networkidle0',
                timeout: 15000 
            });
            
            await this.page.waitForTimeout(3000);
            
            // Verificar se há participantes na reunião
            const meetingActive = await this.page.evaluate(() => {
                // Verificar indicadores de reunião ativa
                const indicators = [
                    '[data-meeting-title]',
                    '[jsname="A5Il2c"]', // Botão mais opções
                    '[data-tooltip*="participante"]',
                    '.google-material-icons',
                    '[aria-label*="pessoas"]',
                    '[data-participant-id]'
                ];
                
                for (const selector of indicators) {
                    if (document.querySelector(selector)) {
                        return true;
                    }
                }
                
                // Verificar se não está na tela de aguardando
                const waitingText = document.body.textContent.toLowerCase();
                return !waitingText.includes('aguardando') && 
                       !waitingText.includes('waiting') &&
                       !waitingText.includes('scheduled') &&
                       !waitingText.includes('agendada');
            });
            
            return meetingActive;
            
        } catch (error) {
            console.log(`⚠️ Erro ao verificar reunião: ${error.message}`);
            return false;
        }
    }

    async joinAndRecord() {
        try {
            const meetingTitle = this.meeting.title || this.meeting.ment_titulo || 'Reunião';
            console.log(`🚪 Entrando na reunião: ${meetingTitle}`);
            
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            await this.page.goto(meetingUrl);
            await this.page.waitForTimeout(5000);
            
            // Desligar câmera e microfone
            await this.toggleMediaDevices();
            
            // Entrar na reunião
            await this.clickJoinButton();
            await this.page.waitForTimeout(5000);
            
            // Iniciar gravação
            const recordingStarted = await this.startRecording();
            
            if (recordingStarted) {
                console.log(`✅ Gravação iniciada para: ${meetingTitle}`);
                await this.monitorRecording();
            } else {
                console.log(`❌ Não foi possível iniciar gravação`);
                await this.cleanup();
            }
            
        } catch (error) {
            console.error(`❌ Erro ao entrar e gravar:`, error.message);
            await this.cleanup();
        }
    }

    async toggleMediaDevices() {
        try {
            // Aguardar elementos aparecerem
            await this.page.waitForTimeout(3000);
            
            // Desligar câmera - múltiplos seletores
            const cameraSelectors = [
                '[data-is-muted="false"][aria-label*="câmera"]',
                '[aria-label*="Desativar câmera"]',
                '[data-tooltip*="câmera"]',
                'button[jsname="BOHaEe"]'
            ];
            
            for (const selector of cameraSelectors) {
                try {
                    const cameraBtn = await this.page.$(selector);
                    if (cameraBtn) {
                        await cameraBtn.click();
                        console.log('📷 Câmera desligada');
                        break;
                    }
                } catch (e) {
                    console.log('⚠️ Erro ao desligar câmera:', e.message);
                    continue;
                }
            }

            // Desligar microfone - múltiplos seletores
            const micSelectors = [
                '[data-is-muted="false"][aria-label*="microfone"]',
                '[aria-label*="Desativar microfone"]',
                '[data-tooltip*="microfone"]',
                'button[jsname="BOHaEe"]'
            ];
            
            for (const selector of micSelectors) {
                try {
                    const micBtn = await this.page.$(selector);
                    if (micBtn) {
                        await micBtn.click();
                        console.log('🎤 Microfone desligado');
                        break;
                    }
                } catch (e) {
                    console.log('⚠️ Erro ao desligar microfone:', e.message);
                    continue;
                }
            }
            
        } catch (error) {
            console.log('⚠️ Não foi possível configurar câmera/microfone:', error.message);
            // Continua mesmo com erro - não é crítico
        }
    }

    async clickJoinButton() {
        const selectors = [
            'button[jsname="Qx7uuf"]',
            '[data-testid="join-button"]',
            'button:has-text("Participar")',
            'button:has-text("Join")',
            'div[role="button"]:has-text("Participar")',
            '[aria-label*="Participar"]',
            '[data-tooltip*="Participar"]'
        ];

        for (const selector of selectors) {
            try {
                const button = await this.page.$(selector);
                if (button) {
                    await button.click();
                    console.log('✅ Clicou em participar');
                    return;
                }
            } catch (e) {
                console.log('⚠️ Erro ao clicar em participar:', e.message);
                continue;
            }
        }
        
        console.log('⚠️ Botão participar não encontrado, tentando Enter');
        await this.page.keyboard.press('Enter');
    }

    async startRecording() {
        console.log('🎥 Iniciando gravação...');
        
        try {
            await this.page.waitForTimeout(8000); // Aguardar página carregar
            
            // Procurar e clicar no botão de mais opções
            const moreSelectors = [
                '[aria-label="Mais opções"]',
                '[data-tooltip="Mais opções"]',
                'button[jsname="A5Il2c"]',
                '[aria-label*="Mais"]'
            ];
            
            let moreButton = null;
            for (const selector of moreSelectors) {
                moreButton = await this.page.$(selector);
                if (moreButton) break;
            }
            
            if (moreButton) {
                await moreButton.click();
                await this.page.waitForTimeout(3000);
                
                // Procurar opção de gravar
                const recordSelectors = [
                    'span:has-text("Gravar reunião")',
                    'div:has-text("Gravar reunião")',
                    '[aria-label*="Gravar"]',
                    'span:contains("Record")',
                    'div:contains("Record")'
                ];
                
                let recordOption = null;
                for (const selector of recordSelectors) {
                    try {
                        recordOption = await this.page.$(selector);
                        if (recordOption) break;
                    } catch (e) {
                        continue;
                    }
                }
                
                if (recordOption) {
                    await recordOption.click();
                    await this.page.waitForTimeout(3000);
                    
                    // Confirmar gravação
                    const confirmSelectors = [
                        'button:has-text("Iniciar")',
                        'button:has-text("Aceitar")',
                        'button:has-text("Start")',
                        '[aria-label*="Iniciar"]'
                    ];
                    
                    for (const selector of confirmSelectors) {
                        try {
                            const confirmBtn = await this.page.$(selector);
                            if (confirmBtn) {
                                await confirmBtn.click();
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                    
                    this.isRecording = true;
                    this.startTime = new Date();
                    
                    // Configurar transcrição
                    await this.setupTranscription();
                    
                    return true;
                } else {
                    console.log('⚠️ Opção de gravação não encontrada no menu');
                }
            } else {
                console.log('⚠️ Botão "Mais opções" não encontrado');
            }
            
            return false;
            
        } catch (error) {
            console.error('❌ Erro ao iniciar gravação:', error.message);
            return false;
        }
    }

    async setupTranscription() {
        try {
            console.log('📝 Configurando transcrição em português...');
            
            await this.page.waitForTimeout(3000);
            
            // Procurar botão de legendas/transcrição
            const captionSelectors = [
                '[aria-label*="legenda"]',
                '[data-tooltip*="legenda"]',
                '[aria-label*="Transcrição"]',
                '[data-tooltip*="Transcrição"]',
                'button[jsname="r8qRAd"]'
            ];
            
            let captionsBtn = null;
            for (const selector of captionSelectors) {
                captionsBtn = await this.page.$(selector);
                if (captionsBtn) break;
            }
            
            if (captionsBtn) {
                await captionsBtn.click();
                await this.page.waitForTimeout(2000);
                
                // Procurar configurações de idioma
                const settingsBtn = await this.page.$('[aria-label*="configurações"]');
                if (settingsBtn) {
                    await settingsBtn.click();
                    await this.page.waitForTimeout(1000);
                    
                    // Selecionar português
                    const portugueseSelectors = [
                        'option[value="pt-BR"]',
                        'span:has-text("Português")',
                        '[data-value="pt-BR"]'
                    ];
                    
                    for (const selector of portugueseSelectors) {
                        try {
                            const portugueseOption = await this.page.$(selector);
                            if (portugueseOption) {
                                await portugueseOption.click();
                                console.log('✅ Transcrição configurada para português');
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
        } catch (error) {
            console.log('⚠️ Não foi possível configurar transcrição:', error.message);
        }
    }

    async monitorRecording() {
        console.log('👀 Monitorando gravação...');
        
        const monitorInterval = setInterval(async () => {
            try {
                // Verificar se ainda está na reunião
                const inMeeting = await this.page.$('.google-material-icons, [data-meeting-title]');
                
                if (!inMeeting) {
                    console.log('📞 Reunião encerrada');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
                // Contar participantes
                const participantSelectors = [
                    '[data-participant-id]',
                    '[jsname="V68bde"]',
                    '[data-self-name]'
                ];
                
                let participants = [];
                for (const selector of participantSelectors) {
                    participants = await this.page.$$(selector);
                    if (participants.length > 0) break;
                }
                
                this.participants = participants.length;
                console.log(`👥 ${this.participants} participantes na reunião`);
                
                // Se só tem o bot, encerrar
                if (this.participants <= 1) {
                    console.log('👥 Só o bot na reunião, encerrando...');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
                // Verificar tempo máximo
                if (this.startTime && (new Date() - this.startTime) > BOT_CONFIG.maxDuration) {
                    console.log('⏰ Tempo máximo atingido, encerrando...');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
            } catch (error) {
                console.error('❌ Erro no monitoramento da gravação:', error.message);
            }
        }, 30000); // A cada 30 segundos
    }

    async stopRecording() {
        if (this.isRecording) {
            console.log('⏹️ Parando gravação...');
            
            try {
                const stopSelectors = [
                    '[aria-label*="Parar"]',
                    'button:has-text("Parar gravação")',
                    '[data-tooltip*="Parar"]'
                ];
                
                let stopBtn = null;
                for (const selector of stopSelectors) {
                    stopBtn = await this.page.$(selector);
                    if (stopBtn) break;
                }
                
                if (stopBtn) {
                    await stopBtn.click();
                    await this.page.waitForTimeout(2000);
                    
                    const confirmBtn = await this.page.$('button:has-text("Parar")');
                    if (confirmBtn) {
                        await confirmBtn.click();
                    }
                }
                
                this.isRecording = false;
                console.log('✅ Gravação parada');
                
            } catch (error) {
                console.error('❌ Erro ao parar gravação:', error.message);
            }
        }
        
        await this.leaveMeeting();
        await this.cleanup();
    }

    async leaveMeeting() {
        console.log('🚪 Saindo da reunião...');
        
        try {
            const leaveSelectors = [
                '[aria-label*="Sair"]',
                '[data-tooltip*="Sair"]',
                'button[jsname="CQylAd"]',
                '[aria-label*="Leave"]'
            ];
            
            let leaveBtn = null;
            for (const selector of leaveSelectors) {
                leaveBtn = await this.page.$(selector);
                if (leaveBtn) break;
            }
            
            if (leaveBtn) {
                await leaveBtn.click();
                console.log('✅ Saiu da reunião');
            }
        } catch (error) {
            console.error('❌ Erro ao sair da reunião:', error.message);
        }
    }

    async cleanup() {
        console.log('🧹 Limpando recursos...');
        
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
            
            console.log('✅ Recursos limpos');
            
        } catch (error) {
            console.error('❌ Erro na limpeza:', error.message);
        }
    }
}

// Página inicial com status
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>🤖 Bot de Gravação Google Meet</title>
            <style>
                body { font-family: Arial; margin: 40px; background: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
                .status { padding: 15px; margin: 10px 0; border-radius: 5px; }
                .success { background: #d4edda; color: #155724; }
                .info { background: #d1ecf1; color: #0c5460; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Bot de Gravação Google Meet</h1>
                <div class="status success">
                    <h3>✅ Servidor Online</h3>
                    <p>Bot pronto para receber agendamentos!</p>
                    <p><strong>Reuniões agendadas:</strong> ${meetings.size}</p>
                    <p><strong>Bots ativos:</strong> ${activeBots.size}</p>
                    <p><strong>Monitorando:</strong> ${monitoringIntervals.size}</p>
                </div>
                <div class="status info">
                    <h3>🔍 Funcionamento</h3>
                    <p>• Bot monitora reunião a cada 30 segundos</p>
                    <p>• Entra automaticamente quando alguém inicia</p>
                    <p>• Grava em português automaticamente</p>
                    <p>• Sai quando reunião termina</p>
                </div>
                <p><strong>URL para n8n:</strong> ${req.protocol}://${req.get('host')}/api/schedule-recording</p>
            </div>
        </body>
        </html>
    `);
});

// Endpoint para agendar gravação (usado pelo n8n)
app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    const meetingTitle = meetingData.title || meetingData.ment_titulo || 'Reunião';
    const eventId = meetingData.eventId || meetingData.ment_id || `meeting_${Date.now()}`;
    
    console.log('📅 Nova reunião agendada:', meetingTitle);
    console.log('📋 Dados recebidos:', JSON.stringify(meetingData, null, 2));
    
    // Validar dados obrigatórios
    const meetingUrl = meetingData.meetingUrl || meetingData.ment_zoom;
    if (!eventId || !meetingUrl) {
        return res.status(400).json({
            success: false,
            message: 'Dados obrigatórios faltando: eventId/ment_id e meetingUrl/ment_zoom são necessários',
            received: meetingData
        });
    }
    
    // Armazenar reunião
    meetings.set(eventId, {
        ...meetingData,
        eventId: eventId, // Garantir que tem eventId
        scheduled: new Date().toISOString(),
        status: 'monitoring'
    });
    
    try {
        // Criar e inicializar bot
        const bot = new MeetingRecordingBot(meetingData);
        activeBots.set(eventId, bot);
        
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log('✅ Bot configurado e monitorando');
        
        res.json({
            success: true,
            message: 'Bot configurado com sucesso!',
            eventId: eventId,
            status: 'monitoring',
            note: 'Bot está monitorando e entrará automaticamente quando a reunião iniciar.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao configurar bot:', error.message);
        
        // Limpar recursos em caso de erro
        activeBots.delete(eventId);
        meetings.delete(eventId);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao configurar bot',
            error: error.message
        });
    }
});

// Endpoint para listar reuniões
app.get('/api/meetings', (req, res) => {
    const meetingsList = Array.from(meetings.values());
    
    res.json({
        total: meetingsList.length,
        active: activeBots.size,
        monitoring: monitoringIntervals.size,
        meetings: meetingsList,
        status: 'Bot funcionando - Monitoramento automático ativo!'
    });
});

// Endpoint para status de reunião específica
app.get('/api/status/:eventId', (req, res) => {
    const eventId = req.params.eventId;
    const meeting = meetings.get(eventId);
    const bot = activeBots.get(eventId);
    
    if (meeting) {
        res.json({
            found: true,
            meeting: meeting,
            botActive: !!bot,
            isMonitoring: monitoringIntervals.has(eventId),
            isRecording: bot ? bot.isRecording : false,
            participants: bot ? bot.participants : 0
        });
    } else {
        res.json({
            found: false,
            message: 'Reunião não encontrada'
        });
    }
});

// Endpoint para parar monitoramento/gravação
app.delete('/api/stop/:eventId', async (req, res) => {
    const eventId = req.params.eventId;
    const bot = activeBots.get(eventId);
    
    if (bot) {
        await bot.cleanup();
        meetings.delete(eventId);
        res.json({ success: true, message: 'Bot parado com sucesso' });
    } else {
        res.json({ success: false, message: 'Bot não encontrado' });
    }
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        chrome: getChromeExecutablePath() || 'Puppeteer padrão'
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT DE GRAVAÇÃO GOOGLE MEET ONLINE');
    console.log('🤖 =====================================');
    console.log(`🌐 Servidor rodando na porta: ${port}`);
    console.log(`🔧 Chrome: ${getChromeExecutablePath() || 'Puppeteer padrão'}`);
    console.log(`📊 Funcionalidades:`);
    console.log(`   👀 Monitoramento automático de reuniões`);
    console.log(`   🚪 Entrada automática quando reunião inicia`);
    console.log(`   🎥 Gravação automática em português`);
    console.log(`   ⏹️ Saída automática quando reunião termina`);
    console.log('✅ Pronto para receber dados do n8n!');
    console.log('🤖 =====================================');
});

// Limpeza ao encerrar
process.on('SIGTERM', async () => {
    console.log('🛑 Encerrando bots...');
    
    for (const [eventId, bot] of activeBots) {
        await bot.cleanup();
    }
    
    process.exit(0);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Erro não tratado:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Exceção não capturada:', error);
});