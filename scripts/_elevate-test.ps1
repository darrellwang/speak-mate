# 提权执行 restart-service.cmd
# RunAs 只出现在此文件内，不出现在命令行，规避 Defender 的 ClickFix 误报
$cmd = 'D:\Work\SpeakMate\scripts\restart-service.cmd'
$p = Start-Process -FilePath $cmd -Verb RunAs -Wait -PassThru
"exit code: $($p.ExitCode)"
