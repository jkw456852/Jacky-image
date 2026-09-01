Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Jacky Image - 设置 API Key'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(460, 150)

$label = New-Object System.Windows.Forms.Label
$label.Text = '请输入 API Key（不会写入网页端）:'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(18, 18)
$form.Controls.Add($label)

$input = New-Object System.Windows.Forms.TextBox
$input.Location = New-Object System.Drawing.Point(18, 48)
$input.Size = New-Object System.Drawing.Size(424, 25)
$input.UseSystemPasswordChar = $true
$form.Controls.Add($input)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = '确定'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = New-Object System.Drawing.Point(278, 95)
$ok.Size = New-Object System.Drawing.Size(78, 28)
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(364, 95)
$cancel.Size = New-Object System.Drawing.Size(78, 28)
$form.Controls.Add($cancel)

$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Add_Shown({ $input.Focus() })

if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($input.Text)
}
