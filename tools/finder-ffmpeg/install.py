#!/usr/bin/env python3
"""Compile the standalone encoder and install its Finder Quick Action."""

import pathlib
import plistlib
import subprocess
import uuid

root = pathlib.Path(__file__).resolve().parent
support = pathlib.Path.home() / "Library/Application Support/Finder FFmpeg Encoder"
services = pathlib.Path.home() / "Library/Services"
workflow = services / "Encode with FFmpeg.workflow/Contents"
support.mkdir(parents=True, exist_ok=True)
workflow.mkdir(parents=True, exist_ok=True)
subprocess.run([
    "swiftc", "-parse-as-library", "-O", str(root / "Encoder.swift"),
    "-o", str(support / "Encoder"),
], check=True)

# Automator's Run Shell Script action accepts selected Finder paths as arguments.
command = f'exec "{support / "Encoder"}" "$1"'
parameters = {
    "COMMAND_STRING": command,
    "CheckedForUserDefaultShell": True,
    "inputMethod": 1,
    "shell": "/bin/zsh",
    "source": "",
}
action = {
    "ActionBundlePath": "/System/Library/Automator/Run Shell Script.action",
    "ActionName": "Run Shell Script",
    "ActionParameters": parameters,
    "AMAccepts": {"Container": "List", "Types": ["com.apple.cocoa.path"]},
    "AMProvides": {"Container": "List", "Types": ["com.apple.cocoa.string"]},
    "AMActionVersion": "2.0.3",
    "AMApplication": ["Automator"],
    "AMParameterProperties": {key: {} for key in parameters},
    "arguments": {str(i): {"name": key, "type": "0", "required": "0", "uuid": str(i), "default value": value}
                  for i, (key, value) in enumerate(parameters.items())},
    "BundleIdentifier": "com.apple.RunShellScript",
    "CanShowSelectedItemsWhenRun": False,
    "CanShowWhenRun": True,
    "Category": ["AMCategoryUtilities"],
    "CFBundleVersion": "2.0.3",
    "Class Name": "RunShellScriptAction",
    "InputUUID": str(uuid.uuid4()).upper(),
    "OutputUUID": str(uuid.uuid4()).upper(),
    "UUID": str(uuid.uuid4()).upper(),
    "isViewVisible": 1,
}
document = {
    "actions": [{"action": action, "isViewVisible": 1}],
    "AMApplicationBuild": "534",
    "AMApplicationVersion": "2.10",
    "AMDocumentVersion": "2",
    "connectors": {},
    "workflowMetaData": {
        "applicationBundleIDsByPath": {},
        "applicationPaths": [],
        "inputTypeIdentifier": "com.apple.Automator.fileSystemObject.movie",
        "outputTypeIdentifier": "com.apple.Automator.nothing",
        "presentationMode": 11,
        "processesInput": False,
        "serviceApplicationBundleID": "com.apple.finder",
        "serviceApplicationPath": "/System/Library/CoreServices/Finder.app",
        "serviceInputTypeIdentifier": "com.apple.Automator.fileSystemObject.movie",
        "serviceOutputTypeIdentifier": "com.apple.Automator.nothing",
        "serviceProcessesInput": False,
        "systemImageName": "NSActionTemplate",
        "useAutomaticInputType": False,
        "workflowTypeIdentifier": "com.apple.Automator.servicesMenu",
    },
}
with (workflow / "document.wflow").open("wb") as file:
    plistlib.dump(document, file)
with (workflow / "Info.plist").open("wb") as file:
    plistlib.dump({
        "CFBundleIdentifier": "dev.antoncode.finder-ffmpeg",
        "CFBundleName": "Encode with FFmpeg",
        "NSServices": [{
            "NSMenuItem": {"default": "Encode with FFmpeg"},
            "NSMessage": "runWorkflowAsService",
            "NSRequiredContext": {"NSApplicationIdentifier": "com.apple.finder"},
            "NSSendFileTypes": ["public.movie"],
        }],
    }, file)
subprocess.run(["/System/Library/CoreServices/pbs", "-flush"], check=True)
print("Installed Finder → Services → Encode with FFmpeg. Finder may need a moment to refresh its menu.")
