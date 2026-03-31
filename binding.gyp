{
  "variables": {
    # Cross-platform WSTP DeveloperKit path.
    # Override by setting WSTP_DIR in the environment.
    # See scripts/wstp_dir.js for auto-detection logic.
    "wstp_dir%": "<!(node scripts/wstp_dir.js)"
  },
  "targets": [
    {
      "target_name": "wstp",
      "sources": [
        "src/addon.cc",
        "src/diag.cc",
        "src/wstp_expr.cc",
        "src/drain.cc",
        "src/evaluate_worker.cc",
        "src/wstp_session.cc",
        "src/wstp_reader.cc"
      ],

      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include.replace(/\\\"/g,'')\")",
        "<(wstp_dir)"
      ],

      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],

      "conditions": [
        ["OS=='mac'", {
          "libraries": ["<(wstp_dir)/libWSTPi4.a"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-Wall", "-Wextra"]
          },
          "link_settings": {
            "libraries": [
              "-framework Foundation",
              "-framework SystemConfiguration",
              "-framework CoreFoundation"
            ]
          }
        }],
        ["OS=='linux'", {
          "libraries": ["<(wstp_dir)/libWSTPi4.a"],
          "cflags_cc": ["-std=c++17", "-Wall", "-Wextra"],
          "link_settings": { "libraries": ["-lrt", "-lpthread", "-ldl", "-lm"] }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          },
          "libraries": [
            "<(wstp_dir)/wstp64i4s.lib",
            "-lws2_32",
            "-lrpcrt4",
            "-lmswsock"
          ]
        }]
      ]
    }
  ]
}
